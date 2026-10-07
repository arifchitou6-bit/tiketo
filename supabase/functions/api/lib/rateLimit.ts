import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError } from "./errors.ts";
import { admin } from "./supabase.ts";
import type { AppEnv } from "./types.ts";

// Adresse IP du client, sans faire confiance à ce que le client envoie lui-même :
// - cf-connecting-ip est posé par Cloudflare (toute valeur envoyée par le client est écrasée) ;
// - sinon, DERNIER élément de X-Forwarded-For : celui ajouté par la passerelle. Le premier élément
//   peut être forgé par le client (vérifié : "X-Forwarded-For: 6.6.6.6" contournait la limite).
export function clientIp(c: Context): string {
  const cloudflare = c.req.header("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded?.at(-1) || c.req.header("x-real-ip") || "unknown";
}

// Limite le nombre de requêtes sur une fenêtre fixe (PRD §9).
// `name` isole les compteurs : dépasser la limite d'une route ne bloque pas les autres.
// `keyOf` choisit qui est compté : l'IP par défaut, ou par exemple la session d'un agent.
export function rateLimit(name: string, limit: number, windowSeconds = 60, keyOf: (c: Context<AppEnv>) => string = clientIp) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_key: `${name}:${keyOf(c)}`,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    // Si le compteur est indisponible, on laisse passer plutôt que de bloquer tous les utilisateurs.
    if (error) {
      console.error("[rate-limit] compteur indisponible", { name, code: error.code });
    } else if (allowed === false) {
      const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
      c.header("Retry-After", String(retryAfter));
      throw new ApiError(429, "RATE_LIMITED", `Trop de tentatives, réessayez dans ${retryAfter} secondes`);
    }
    await next();
  });
}
