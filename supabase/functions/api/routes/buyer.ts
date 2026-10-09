// Compte acheteur (PRD v2) — connexion par code à 6 chiffres envoyé par e-mail, sans mot de passe.
// Le compte est créé à la première connexion réussie.

import { Hono } from "hono";
import { z } from "zod";
import { requireBuyer, sha256Hex } from "../lib/auth.ts";
import { sendOtpEmail } from "../lib/email.ts";
import { ApiError, fromDbError } from "../lib/errors.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { emailSchema, parseJson } from "../lib/validation.ts";

const OTP_TTL_MINUTES = 10;
const OTP_COOLDOWN_SECONDS = 60;     // délai minimal entre deux envois pour un même e-mail
const OTP_MAX_PER_HOUR = 5;          // envois maximum par e-mail et par heure (quota Brevo : 300/jour)
const OTP_MAX_ATTEMPTS = 5;          // essais par code
const SESSION_DAYS = 30;

// Compte de démonstration (bouton « connexion en un clic » du front) : code fixe, aucun e-mail envoyé.
// Public par nature (README) ; ses commandes et favoris sont restaurés chaque nuit avec la démo.
export const DEMO_BUYER = { email: "acheteur@ticketo.bj", code: "246810" };

const codeHash = (email: string, code: string) => sha256Hex(`${email}:${code}`);

const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "deviceId invalide (8 à 100 caractères : lettres, chiffres, - ou _)");

const requestSchema = z.object({ email: emailSchema }).strict();
const verifySchema = z.object({
  email: emailSchema,
  code: z.string({ required_error: "Le code est requis" }).trim().regex(/^\d{6}$/, "Le code contient 6 chiffres"),
  deviceId: deviceIdSchema.optional(),
}).strict();

const ordersQuerySchema = z.object({
  page: z.coerce.number().int().min(1, "page doit être ≥ 1").default(1),
  pageSize: z.coerce.number().int().min(1).max(50, "pageSize maximum : 50").default(20),
  status: z.enum(["PAID", "PENDING", "FAILED"], { errorMap: () => ({ message: "Statut invalide (PAID, PENDING ou FAILED)" }) })
    .optional(),
});

async function loadBuyer(id: string) {
  const { data, error } = await admin.from("buyers").select("id, email, name, phone, created_at").eq("id", id).single();
  if (error) throw fromDbError(error);
  return { id: data.id, email: data.email, name: data.name, phone: data.phone, createdAt: data.created_at };
}

const VERIFY_ERRORS: Record<string, [number, string]> = {
  OTP_INVALID: [401, "Code incorrect"],
  OTP_EXPIRED: [401, "Ce code a expiré, demandez-en un nouveau"],
  OTP_TOO_MANY_ATTEMPTS: [429, "Trop d'essais incorrects, demandez un nouveau code"],
};

export const buyerRoutes = new Hono<AppEnv>();

// Envoi du code. Réponse identique que le compte existe ou non (pas de divulgation des e-mails inscrits).
buyerRoutes.post("/otp/request", rateLimit("buyer-otp", 5), async (c) => {
  const { email } = await parseJson(c, requestSchema);
  const sent = { sent: true, expiresInSeconds: OTP_TTL_MINUTES * 60, retryAfterSeconds: OTP_COOLDOWN_SECONDS };
  if (email === DEMO_BUYER.email) return c.json({ ...sent, demo: true });

  // Plafond par e-mail : empêche d'inonder une boîte (ou d'épuiser le quota d'envoi) depuis plusieurs IP
  const { data: allowed, error: limitError } = await admin.rpc("rate_limit_hit", {
    p_key: `buyer-otp-email:${email}`, p_limit: OTP_MAX_PER_HOUR, p_window_seconds: 3600,
  });
  if (limitError) console.error("[buyer] compteur indisponible", { code: limitError.code });
  if (allowed === false) {
    throw new ApiError(429, "RATE_LIMITED", "Trop de codes demandés pour cet e-mail, réessayez dans une heure");
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const { data, error } = await admin.rpc("buyer_otp_store", {
    p_email: email, p_code_hash: await codeHash(email, code), p_ttl_seconds: OTP_TTL_MINUTES * 60,
    p_cooldown_seconds: OTP_COOLDOWN_SECONDS,
  });
  if (error) throw fromDbError(error);
  const stored = data as { ok: boolean; retryAfter?: number };
  if (!stored.ok) {
    c.header("Retry-After", String(stored.retryAfter));
    throw new ApiError(429, "OTP_COOLDOWN", `Un code vient d'être envoyé, patientez ${stored.retryAfter} secondes avant d'en redemander un`);
  }

  await sendOtpEmail(email, code, OTP_TTL_MINUTES);
  return c.json(sent);
});

// Vérification du code → session de 30 jours. deviceId (optionnel) rattache les likes de l'appareil au compte.
buyerRoutes.post("/otp/verify", rateLimit("buyer-verify", 10), async (c) => {
  const { email, code, deviceId } = await parseJson(c, verifySchema);
  const isDemo = email === DEMO_BUYER.email;
  if (isDemo && code !== DEMO_BUYER.code) throw new ApiError(401, "OTP_INVALID", "Code incorrect", "code");

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const { data, error } = await admin.rpc("buyer_otp_verify", {
    p_email: email,
    p_code_hash: await codeHash(email, code),
    p_token_hash: await sha256Hex(token),
    p_session_days: SESSION_DAYS,
    p_device_id: deviceId ?? null,
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_skip_code: isDemo,
  });
  if (error) throw fromDbError(error);

  const result = data as { ok: boolean; reason?: string; attemptsLeft?: number; buyerId?: string; sessionExpiresAt?: string };
  if (!result.ok) {
    const [status, message] = VERIFY_ERRORS[result.reason!] ?? VERIFY_ERRORS.OTP_INVALID;
    const left = result.reason === "OTP_INVALID" && result.attemptsLeft
      ? ` (${result.attemptsLeft} essai${result.attemptsLeft > 1 ? "s" : ""} restant${result.attemptsLeft > 1 ? "s" : ""})`
      : "";
    throw new ApiError(status as 401 | 429, result.reason!, message + left, "code");
  }

  c.header("Cache-Control", "no-store");
  return c.json({
    buyer: await loadBuyer(result.buyerId!),
    session: { token, expiresAt: result.sessionExpiresAt, tokenType: "bearer" },
  });
});

buyerRoutes.get("/me", requireBuyer, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ buyer: await loadBuyer(c.get("buyer")!.buyerId) });
});

buyerRoutes.post("/logout", requireBuyer, async (c) => {
  const { error } = await admin.from("buyer_sessions").update({ revoked_at: new Date().toISOString() })
    .eq("id", c.get("buyer")!.sessionId);
  if (error) throw fromDbError(error);
  return c.body(null, 204);
});

// Commandes passées avec l'e-mail du compte (même avant sa création) ou en étant connecté
buyerRoutes.get("/orders", requireBuyer, async (c) => {
  const parsed = ordersQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, "VALIDATION_ERROR", issue.message, issue.path.join(".") || undefined);
  }
  const { page, pageSize, status } = parsed.data;
  const buyer = c.get("buyer")!;

  const { data, error } = await admin.rpc("buyer_orders", {
    p_buyer_id: buyer.buyerId, p_email: buyer.email, p_status: status ?? null,
    p_limit: pageSize, p_offset: (page - 1) * pageSize,
  });
  if (error) throw fromDbError(error);

  const { orders, total } = data as { orders: unknown[]; total: number };
  c.header("Cache-Control", "no-store");
  return c.json({ orders, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
});

// Événements likés en étant connecté (ou sur un appareil rattaché au compte)
buyerRoutes.get("/favorites", requireBuyer, async (c) => {
  const { data, error } = await admin.rpc("buyer_favorites", { p_buyer_id: c.get("buyer")!.buyerId });
  if (error) throw fromDbError(error);
  c.header("Cache-Control", "no-store");
  return c.json({ events: data });
});
