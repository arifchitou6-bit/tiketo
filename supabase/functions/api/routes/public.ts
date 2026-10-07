// Page publique d'un événement (PRD §6.3) — sans authentification.
// Aucune donnée organisateur, aucun chiffre de vente, aucun secret.

import { Hono } from "hono";
import { fromDbError, notFound } from "../lib/errors.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";

const CACHE_SECONDS = 30;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Cache mémoire de l'instance (30 s, comme le cache HTTP) : protège la base lors d'un pic
// de visites (lien partagé sur Instagram/WhatsApp). Les quotas sont revérifiés à la commande.
const memoryCache = new Map<string, { expires: number; body: unknown }>();

async function loadPublicEvent(slug: string) {
  const { data: event, error } = await admin
    .from("events")
    .select("id, slug, name, description, cover_image_url, venue, city, starts_at, ends_at, status")
    .eq("slug", slug)
    .in("status", ["PUBLISHED", "CLOSED"])
    .maybeSingle();
  if (error) throw fromDbError(error);
  if (!event) return null;

  const { data: cats, error: catError } = await admin
    .from("ticket_categories")
    .select("id, name, price_fcfa, quantity, sold")
    .eq("event_id", event.id)
    .order("position");
  if (catError) throw fromDbError(catError);

  const categories = (cats ?? []).map((c) => {
    const remaining = Math.max(c.quantity - c.sold, 0);
    return { id: c.id, name: c.name, priceFcfa: c.price_fcfa, remaining, isSoldOut: remaining === 0 };
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
      coverImageUrl: event.cover_image_url,
      venue: event.venue,
      city: event.city,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      status: event.status,
      isPast,
      isSoldOut,
      isSalesOpen: event.status === "PUBLISHED" && !isPast && !isSoldOut,
      minPriceFcfa: priced.length ? Math.min(...priced.map((c) => c.priceFcfa)) : null,
      categories,
    },
  };
}

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/events/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 80) throw notFound("Événement introuvable");

  const cached = memoryCache.get(slug);
  let body = cached && cached.expires > Date.now() ? cached.body : null;
  c.header("X-Cache", body ? "HIT" : "MISS");

  if (!body) {
    body = await loadPublicEvent(slug);
    if (!body) throw notFound("Événement introuvable");
    memoryCache.set(slug, { expires: Date.now() + CACHE_SECONDS * 1000, body });
    if (memoryCache.size > 500) memoryCache.delete(memoryCache.keys().next().value!);
  }

  c.header("Cache-Control", `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`);
  return c.json(body);
});
