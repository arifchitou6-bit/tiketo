// Authentification organisateur (PRD §6.1) — Supabase Auth, session par jeton Bearer.

import { Hono } from "hono";
import type { Session } from "@supabase/supabase-js";
import { z } from "zod";
import { randomToken, requireOrganizer, sha256Hex } from "../lib/auth.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { ApiError, fromDbError } from "../lib/errors.ts";
import { admin, anonClient } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { emailSchema, nameSchema, parseJson } from "../lib/validation.ts";
import { BUYER_ACCESS_SECONDS, buyerSession } from "./buyer.ts";

const signupSchema = z
  .object({
    email: emailSchema,
    password: z
      .string({ required_error: "Le mot de passe est requis" })
      .min(8, "Le mot de passe doit contenir au moins 8 caractères")
      .max(72, "Le mot de passe ne peut pas dépasser 72 caractères"),
    name: nameSchema,
  })
  .strict();

const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string({ required_error: "Le mot de passe est requis" }).min(1, "Le mot de passe est requis"),
  })
  .strict();

const refreshSchema = z
  .object({ refreshToken: z.string({ required_error: "refreshToken est requis" }).min(1) })
  .strict();

function toSession(session: Session) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    expiresAt: new Date((session.expires_at ?? 0) * 1000).toISOString(),
    tokenType: "bearer",
  };
}

async function loadUser(id: string) {
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, name, created_at")
    .eq("id", id)
    .single();
  if (error || !data) throw new ApiError(500, "INTERNAL_ERROR", "Profil introuvable");
  return { id: data.id, email: data.email, name: data.name, createdAt: data.created_at };
}

async function signIn(email: string, password: string) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email ou mot de passe incorrect");
  }
  return data.session;
}

export const authRoutes = new Hono<AppEnv>();

// 10 requêtes/min par IP, partagées entre inscription, connexion et renouvellement (PRD §9)
const authLimit = rateLimit("auth", 10);

authRoutes.post("/signup", authLimit, async (c) => {
  const body = await parseJson(c, signupSchema);

  // Compte confirmé d'office : pas d'email de vérification dans le périmètre (PRD §4.2).
  const { data, error } = await admin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { name: body.name },
  });
  if (error) {
    if (error.code === "email_exists" || /already/i.test(error.message)) {
      throw new ApiError(409, "EMAIL_TAKEN", "Un compte existe déjà avec cet email", "email");
    }
    if (error.code === "weak_password") {
      throw new ApiError(400, "WEAK_PASSWORD", "Mot de passe trop faible", "password");
    }
    console.error("[auth] échec de création de compte", { code: error.code });
    throw new ApiError(500, "INTERNAL_ERROR", "Impossible de créer le compte");
  }

  const session = await signIn(body.email, body.password);
  return c.json({ user: await loadUser(data.user.id), session: toSession(session) }, 201);
});

authRoutes.post("/login", authLimit, async (c) => {
  const body = await parseJson(c, loginSchema);
  const session = await signIn(body.email, body.password);
  return c.json({ user: await loadUser(session.user.id), session: toSession(session) });
});

// Renouvelle une session organisateur OU acheteur (PRD v2.1 §8.4 : même renouvellement).
// Les jetons de renouvellement acheteur sont opaques (64 caractères hexadécimaux) ; rotation à chaque appel.
authRoutes.post("/refresh", authLimit, async (c) => {
  const body = await parseJson(c, refreshSchema);
  if (/^[0-9a-f]{64}$/.test(body.refreshToken)) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const { data, error } = await admin.rpc("buyer_refresh", {
      p_refresh_hash: await sha256Hex(body.refreshToken),
      p_token_hash: await sha256Hex(accessToken),
      p_new_refresh_hash: await sha256Hex(refreshToken),
      p_access_seconds: BUYER_ACCESS_SECONDS,
    });
    if (error) throw fromDbError(error);
    const result = data as { ok: boolean; expiresAt?: string };
    if (!result.ok) throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Session expirée, veuillez vous reconnecter");
    return c.json({ session: buyerSession(accessToken, refreshToken, result.expiresAt!) });
  }
  const { data, error } = await anonClient().auth.refreshSession({ refresh_token: body.refreshToken });
  if (error || !data.session) {
    throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Session expirée, veuillez vous reconnecter");
  }
  return c.json({ session: toSession(data.session) });
});

authRoutes.post("/logout", requireOrganizer, async (c) => {
  const { error } = await admin.auth.admin.signOut(c.get("user").accessToken, "local");
  if (error) console.error("[auth] échec de déconnexion", { code: error.code });
  return c.body(null, 204);
});

authRoutes.get("/me", requireOrganizer, async (c) => {
  return c.json({ user: await loadUser(c.get("user").id) });
});
