// Pages publiques (PRD §6.3 et v2) — sans authentification : liste et recherche, détail, likes.
// Aucune donnée organisateur, aucun chiffre de vente, aucun secret.

import { Hono } from "hono";
import { z } from "zod";
import { ApiError, fromDbError, notFound } from "../lib/errors.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { parseJson } from "../lib/validation.ts";
import { EVENT_CATEGORIES } from "./events.ts";

const CACHE_SECONDS = 30;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Cache mémoire de l'instance (30 s, comme le cache HTTP) : protège la base lors d'un pic
// de visites (lien partagé sur Instagram/WhatsApp). Les quotas sont revérifiés à la commande.
const memoryCache = new Map<string, { expires: number; body: unknown }>();

async function loadPublicEvent(slug: string) {
  const { data: event, error } = await admin
    .from("events")
    .select("id, slug, name, description, category, cover_image_url, cover_fit, venue, city, country, time_zone, starts_at, ends_at, status, likes_count")
    .eq("slug", slug)
    .in("status", ["PUBLISHED", "CLOSED"])
    .maybeSingle();
  if (error) throw fromDbError(error);
  if (!event) return null;

  const { data: cats, error: catError } = await admin
    .from("ticket_categories")
    .select("id, name, description, price_fcfa, quantity, sold")
    .eq("event_id", event.id)
    .order("position");
  if (catError) throw fromDbError(catError);

  const categories = (cats ?? []).map((c) => {
    const remaining = Math.max(c.quantity - c.sold, 0);
    return { id: c.id, name: c.name, description: c.description, priceFcfa: c.price_fcfa, remaining, isSoldOut: remaining === 0 };
  });
  const isPast = new Date(event.ends_at).getTime() <= Date.now();
  const isSoldOut = categories.length > 0 && categories.every((c) => c.isSoldOut);
  // "À partir de …" : prix le plus bas parmi les catégories encore disponibles (toutes si complet)
  const priced = categories.some((c) => !c.isSoldOut) ? categories.filter((c) => !c.isSoldOut) : categories;

  return {
    event: {
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      category: event.category,
      coverImageUrl: event.cover_image_url,
      coverFit: event.cover_fit,
      venue: event.venue,
      city: event.city,
      country: event.country,
      timeZone: event.time_zone,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      status: event.status,
      likesCount: event.likes_count,
      isPast,
      isSoldOut,
      isSalesOpen: event.status === "PUBLISHED" && !isPast && !isSoldOut,
      minPriceFcfa: priced.length ? Math.min(...priced.map((c) => c.priceFcfa)) : null,
      categories,
    },
  };
}

type PublicEventBody = NonNullable<Awaited<ReturnType<typeof loadPublicEvent>>>;

// Identifiant d'appareil généré et conservé par le front (ex. UUID en localStorage)
const deviceIdSchema = z.string({ required_error: "deviceId est requis" }).regex(
  /^[A-Za-z0-9_-]{8,100}$/,
  "deviceId invalide (8 à 100 caractères : lettres, chiffres, - ou _)",
);

// --- Curseur de pagination : jeton opaque (JSON en base64url) ------------------

type Sort = "date" | "popular";
interface Cursor { o: Sort; s: string; id: string; l: number }

const encodeCursor = (sort: Sort, next: Omit<Cursor, "o">) =>
  btoa(JSON.stringify({ o: sort, ...next })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeCursor(raw: string, sort: Sort): Cursor {
  const invalid = new ApiError(400, "INVALID_CURSOR", "Curseur de pagination invalide : recommencez sans curseur", "cursor");
  try {
    const c = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
    if (c.o !== sort) throw invalid; // curseur obtenu avec un autre tri
    if (Number.isNaN(Date.parse(c.s)) || !/^[0-9a-f-]{36}$/i.test(c.id) || !Number.isInteger(c.l)) throw invalid;
    return c;
  } catch {
    throw invalid;
  }
}

const listQuerySchema = z.object({
  q: z.string().trim().max(100, "Recherche : 100 caractères maximum").optional(),
  category: z.enum(EVENT_CATEGORIES, {
    errorMap: () => ({ message: `Catégorie invalide (${EVENT_CATEGORIES.join(", ")})` }),
  }).optional(),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Code pays ISO à 2 lettres attendu (ex. BJ)").optional(),
  sort: z.enum(["date", "popular"], { errorMap: () => ({ message: "sort : « date » ou « popular »" }) }).default("date"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1, "limit doit être ≥ 1").max(50, "limit maximum : 50").default(12),
  deviceId: deviceIdSchema.optional(),
});

// --- Routes ------------------------------------------------------------------

export const publicRoutes = new Hono<AppEnv>();

// Accueil et recherche : événements publiés et non terminés
publicRoutes.get("/events", async (c) => {
  // Paramètres vides (?q=&category=) = filtre absent
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== ""));
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, "VALIDATION_ERROR", issue.message, issue.path.join(".") || undefined);
  }
  const { q, category, country, sort, cursor, limit, deviceId } = parsed.data;

  const { data, error } = await admin.rpc("list_public_events", {
    p_q: q ?? null,
    p_category: category ?? null,
    p_country: country ?? null,
    p_sort: sort,
    p_cursor: cursor ? decodeCursor(cursor, sort) : null,
    p_limit: limit,
    p_device_id: deviceId ?? null,
  });
  if (error) throw fromDbError(error);

  const { events, next } = data as { events: unknown[]; next: Omit<Cursor, "o"> | null };
  // Avec deviceId, la réponse est propre à l'appareil (isLiked) : pas de cache partagé
  c.header("Cache-Control", deviceId ? "private, no-store" : `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
  return c.json({ events, nextCursor: next ? encodeCursor(sort, next) : null });
});

publicRoutes.get("/events/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 80) throw notFound("Événement introuvable");

  const cached = memoryCache.get(slug);
  let body = cached && cached.expires > Date.now() ? cached.body as PublicEventBody : null;
  c.header("X-Cache", body ? "HIT" : "MISS");

  if (!body) {
    body = await loadPublicEvent(slug);
    if (!body) throw notFound("Événement introuvable");
    memoryCache.set(slug, { expires: Date.now() + CACHE_SECONDS * 1000, body });
    if (memoryCache.size > 500) memoryCache.delete(memoryCache.keys().next().value!);
  }

  // ?deviceId=… : ajoute isLiked (hors cache, propre à l'appareil)
  const deviceId = c.req.query("deviceId");
  if (deviceId) {
    const valid = deviceIdSchema.safeParse(deviceId);
    if (!valid.success) throw new ApiError(400, "VALIDATION_ERROR", valid.error.issues[0].message, "deviceId");
    const { data: isLiked, error } = await admin.rpc("is_event_liked", { p_event_id: body.event.id, p_device_id: deviceId });
    if (error) throw fromDbError(error);
    c.header("Cache-Control", "private, no-store");
    return c.json({ event: { ...body.event, isLiked } });
  }

  c.header("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`);
  return c.json(body);
});

// Like / unlike : un par appareil, idempotent. deviceId dans le corps JSON (ou ?deviceId= pour DELETE,
// certains clients n'envoyant pas de corps avec DELETE).
const likeBodySchema = z.object({ deviceId: deviceIdSchema }).strict();

async function setLike(slug: string, deviceId: string, liked: boolean) {
  slug = slug.toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 80) throw notFound("Événement introuvable");
  const { data, error } = await admin.rpc("set_event_like", { p_slug: slug, p_device_id: deviceId, p_liked: liked });
  if (error) throw fromDbError(error);
  return data as { liked: boolean; likesCount: number };
}

publicRoutes.post("/events/:slug/like", rateLimit("like", 60), async (c) => {
  const { deviceId } = await parseJson(c, likeBodySchema);
  return c.json(await setLike(c.req.param("slug"), deviceId, true));
});

publicRoutes.delete("/events/:slug/like", rateLimit("like", 60), async (c) => {
  let deviceId = c.req.query("deviceId");
  if (!deviceId) deviceId = (await parseJson(c, likeBodySchema)).deviceId;
  const valid = deviceIdSchema.safeParse(deviceId);
  if (!valid.success) throw new ApiError(400, "VALIDATION_ERROR", valid.error.issues[0].message, "deviceId");
  return c.json(await setLike(c.req.param("slug"), deviceId, false));
});
