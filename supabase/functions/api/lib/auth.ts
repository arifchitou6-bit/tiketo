import { createMiddleware } from "hono/factory";
import { fromDbError, unauthorized } from "./errors.ts";
import { admin } from "./supabase.ts";
import type { AppEnv } from "./types.ts";

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Protège une route organisateur : exige un jeton Supabase valide (Authorization: Bearer <accessToken>).
// 1. getClaims() vérifie la signature et l'expiration localement (clé publique JWKS mise en cache) :
//    quelques ms au lieu d'un aller-retour vers le service Auth à chaque requête.
// 2. is_session_active() confirme que la session n'a pas été fermée : la déconnexion reste immédiate.
export const requireOrganizer = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw unauthorized();

  const { data, error } = await admin.auth.getClaims(token);
  const claims = data?.claims;
  if (error || !claims?.sub || !claims.session_id || claims.role !== "authenticated") {
    throw unauthorized("Session invalide ou expirée");
  }

  const { data: active, error: sessionError } = await admin.rpc("is_session_active", {
    p_session_id: claims.session_id,
    p_user_id: claims.sub,
  });
  if (sessionError) throw fromDbError(sessionError);
  if (!active) throw unauthorized("Session invalide ou expirée");

  c.set("user", { id: claims.sub, email: (claims.email as string | undefined) ?? "", accessToken: token });
  await next();
});

// Protège une route staff : exige un jeton de session staff valide, non révoqué, non expiré.
export const requireStaff = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw unauthorized();

  const { data, error } = await admin
    .from("staff_sessions")
    .select("id, event_id, staff_code")
    .eq("token_hash", await sha256Hex(token))
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw unauthorized("Session staff invalide ou expirée, reconnectez-vous avec le code et le PIN");

  c.set("staff", { sessionId: data.id, eventId: data.event_id, staffCode: data.staff_code });
  await next();
});

// Session acheteur (compte par code e-mail) : jeton opaque, seule son empreinte est stockée.
async function findBuyerSession(token: string) {
  const { data, error } = await admin
    .from("buyer_sessions")
    .select("id, buyer_id, buyer:buyers ( email )")
    .eq("token_hash", await sha256Hex(token))
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw fromDbError(error);
  // deno-lint-ignore no-explicit-any
  return data ? { sessionId: data.id, buyerId: data.buyer_id, email: (data.buyer as any).email as string } : null;
}

const buyerExpired = () => unauthorized("Session acheteur invalide ou expirée, reconnectez-vous avec votre e-mail");

// Protège une route de l'espace acheteur
export const requireBuyer = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw unauthorized();
  const session = await findBuyerSession(token);
  if (!session) throw buyerExpired();
  c.set("buyer", session);
  await next();
});

// Route publique qui rattache l'action au compte si l'acheteur est connecté (commande, like).
// Un jeton présent mais invalide est refusé (401) : le front sait qu'il doit reconnecter l'acheteur.
export const optionalBuyer = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    const session = await findBuyerSession(token);
    if (!session) throw buyerExpired();
    c.set("buyer", session);
  }
  await next();
});
