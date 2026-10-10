// Compte acheteur (PRD v2.1 §8.4) — connexion par numéro de téléphone et code à 6 chiffres, sans mot de passe.
// Démo : aucun SMS n'est envoyé, le code est renvoyé dans `devCode` (BUYER_OTP_DEV_CODE=off pour le couper).
// Le compte est créé à la première connexion réussie.

import { Hono } from "hono";
import { z } from "zod";
import { randomToken, requireBuyer, sha256Hex } from "../lib/auth.ts";
import { ApiError, fromDbError } from "../lib/errors.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { parseJson, phoneSchema } from "../lib/validation.ts";
import { loadOrder, loadTickets } from "./orders.ts";

const OTP_TTL_MINUTES = 10;
const OTP_COOLDOWN_SECONDS = 60;     // délai minimal entre deux codes pour un même numéro
const OTP_MAX_PER_HOUR = 5;          // codes maximum par numéro et par heure
const OTP_MAX_ATTEMPTS = 5;          // essais par code (PRD §9)
export const BUYER_ACCESS_SECONDS = 3600;   // comme la session organisateur (1 h, renouvelée par /auth/refresh)
export const BUYER_REFRESH_DAYS = 30;
const MAX_ORDERS = 100;

// devCode activé par défaut (démo sans SMS) ; BUYER_OTP_DEV_CODE=off le coupe pour une production avec vrais SMS
const devCodeEnabled = () => (Deno.env.get("BUYER_OTP_DEV_CODE") ?? "on").toLowerCase() !== "off";

const codeHash = (phone: string, code: string) => sha256Hex(`${phone}:${code}`);

const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "deviceId invalide (8 à 100 caractères : lettres, chiffres, - ou _)");

const requestSchema = z.object({ phone: phoneSchema }).strict();
const verifySchema = z.object({
  phone: phoneSchema,
  code: z.string({ required_error: "Le code est requis" }).trim().regex(/^\d{6}$/, "Le code contient 6 chiffres"),
  deviceId: deviceIdSchema.optional(),
}).strict();

// Session au format de la session organisateur (routes/auth.ts)
export function buyerSession(accessToken: string, refreshToken: string, expiresAt: string) {
  return { accessToken, refreshToken, expiresIn: BUYER_ACCESS_SECONDS, expiresAt: new Date(expiresAt).toISOString(), tokenType: "bearer" };
}

// buyer = { id, phone, name } ; name : celui de sa dernière commande payée (PRD §7)
async function loadBuyer(id: string) {
  const { data, error } = await admin.from("buyers").select("id, phone, created_at").eq("id", id).single();
  if (error) throw fromDbError(error);
  const { data: last, error: lastError } = await admin.from("orders").select("buyer_name")
    .in("buyer_phone", phoneVariants(data.phone)).eq("status", "PAID")
    .order("paid_at", { ascending: false }).limit(1).maybeSingle();
  if (lastError) throw fromDbError(lastError);
  return { id: data.id, phone: data.phone, name: last?.buyer_name ?? null, createdAt: data.created_at };
}

// Une commande peut avoir été passée avec ou sans le « + » de l'indicatif
const phoneVariants = (phone: string) => [phone, phone.startsWith("+") ? phone.slice(1) : `+${phone}`];

const VERIFY_ERRORS: Record<string, string> = {
  OTP_INVALID: "Code incorrect",
  OTP_EXPIRED: "Ce code a expiré, demandez-en un nouveau",
  OTP_TOO_MANY_ATTEMPTS: "Trop d'essais incorrects, demandez un nouveau code",
};

export const buyerRoutes = new Hono<AppEnv>();

// Demande de code. Réponse identique que le compte existe ou non.
buyerRoutes.post("/otp/request", rateLimit("buyer-otp", 5), async (c) => {
  const { phone } = await parseJson(c, requestSchema);

  // Plafond par numéro : empêche de saturer un numéro (ou un futur quota SMS) depuis plusieurs IP
  const { data: allowed, error: limitError } = await admin.rpc("rate_limit_hit", {
    p_key: `buyer-otp-phone:${phone}`, p_limit: OTP_MAX_PER_HOUR, p_window_seconds: 3600,
  });
  if (limitError) console.error("[buyer] compteur indisponible", { code: limitError.code });
  if (allowed === false) {
    c.header("Retry-After", "3600");
    throw new ApiError(429, "RATE_LIMITED", "Trop de codes demandés pour ce numéro, réessayez dans une heure", "phone");
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const { data, error } = await admin.rpc("buyer_otp_store", {
    p_phone: phone, p_code_hash: await codeHash(phone, code), p_ttl_seconds: OTP_TTL_MINUTES * 60,
    p_cooldown_seconds: OTP_COOLDOWN_SECONDS,
  });
  if (error) throw fromDbError(error);
  const stored = data as { ok: boolean; retryAfter?: number };
  if (!stored.ok) {
    c.header("Retry-After", String(stored.retryAfter));
    throw new ApiError(429, "RATE_LIMITED", `Un code vient d'être envoyé, patientez ${stored.retryAfter} secondes avant d'en redemander un`, "phone");
  }

  // Aucun SMS en démo (PRD §8.4). Le module e-mail Brevo (lib/email.ts) reste disponible pour plus tard.
  c.header("Cache-Control", "no-store");
  return c.json({
    ...(devCodeEnabled() ? { devCode: code } : {}),
    expiresInSeconds: OTP_TTL_MINUTES * 60,
    retryAfterSeconds: OTP_COOLDOWN_SECONDS,
  });
});

// Vérification du code → session. deviceId rattache au compte les likes de l'appareil.
buyerRoutes.post("/otp/verify", rateLimit("buyer-verify", 10), async (c) => {
  const { phone, code, deviceId } = await parseJson(c, verifySchema);

  const accessToken = randomToken();
  const refreshToken = randomToken();
  const { data, error } = await admin.rpc("buyer_otp_verify", {
    p_phone: phone,
    p_code_hash: await codeHash(phone, code),
    p_token_hash: await sha256Hex(accessToken),
    p_refresh_hash: await sha256Hex(refreshToken),
    p_access_seconds: BUYER_ACCESS_SECONDS,
    p_refresh_days: BUYER_REFRESH_DAYS,
    p_device_id: deviceId ?? null,
    p_max_attempts: OTP_MAX_ATTEMPTS,
  });
  if (error) throw fromDbError(error);

  const result = data as { ok: boolean; reason?: string; attemptsLeft?: number; buyerId?: string; expiresAt?: string };
  if (!result.ok) {
    // Codes du PRD : un code bloqué après 5 erreurs est traité comme expiré (il faut en redemander un)
    const code = result.reason === "OTP_INVALID" ? "OTP_INVALID" : "OTP_EXPIRED";
    const left = result.reason === "OTP_INVALID" && result.attemptsLeft
      ? ` (${result.attemptsLeft} essai${result.attemptsLeft > 1 ? "s" : ""} restant${result.attemptsLeft > 1 ? "s" : ""})`
      : "";
    throw new ApiError(401, code, VERIFY_ERRORS[result.reason!] + left, "code");
  }

  c.header("Cache-Control", "no-store");
  return c.json({ buyer: await loadBuyer(result.buyerId!), session: buyerSession(accessToken, refreshToken, result.expiresAt!) });
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

// Commandes payées avec ce numéro (sur n'importe quel appareil), au format de GET /orders/:id
buyerRoutes.get("/orders", requireBuyer, async (c) => {
  const { data, error } = await admin.from("orders").select("id")
    .in("buyer_phone", phoneVariants(c.get("buyer")!.phone)).eq("status", "PAID")
    .order("paid_at", { ascending: false }).limit(MAX_ORDERS);
  if (error) throw fromDbError(error);

  const orders = await Promise.all(data.map(async ({ id }) => ({ order: await loadOrder(id), tickets: await loadTickets(id) })));
  c.header("Cache-Control", "no-store");
  return c.json({ orders });
});

// Événements likés en étant connecté (ou sur un appareil rattaché au compte)
buyerRoutes.get("/favorites", requireBuyer, async (c) => {
  const { data, error } = await admin.rpc("buyer_favorites", { p_buyer_id: c.get("buyer")!.buyerId });
  if (error) throw fromDbError(error);
  c.header("Cache-Control", "no-store");
  return c.json({ events: data });
});
