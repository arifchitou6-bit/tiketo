// Gestion des événements par l'organisateur (PRD §6.2) — toutes les routes exigent une session.

import { Hono } from "hono";
import { z } from "zod";
import { requireOrganizer } from "../lib/auth.ts";
import { env } from "../lib/env.ts";
import { ApiError, fromDbError, notFound } from "../lib/errors.ts";
import { generateSlug } from "../lib/slug.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { parseJson } from "../lib/validation.ts";

// --- Validation --------------------------------------------------------------

const isoDate = z
  .string({ required_error: "La date est requise" })
  .datetime({ offset: true, message: "Date au format ISO 8601 attendue (ex. 2026-12-31T20:00:00Z)" });

const categoryFields = {
  name: z.string({ required_error: "Le nom de la catégorie est requis" }).trim().min(1, "Le nom de la catégorie est requis")
    .max(60, "60 caractères maximum"),
  priceFcfa: z.number({ required_error: "Le prix est requis", invalid_type_error: "Le prix doit être un nombre" })
    .int("Le prix doit être un entier en FCFA").min(0, "Le prix ne peut pas être négatif").max(10_000_000, "Prix trop élevé"),
  quantity: z.number({ required_error: "La quantité est requise", invalid_type_error: "La quantité doit être un nombre" })
    .int("La quantité doit être un entier").min(1, "Au moins 1 ticket").max(100_000, "100 000 tickets maximum"),
};

const newCategorySchema = z.object(categoryFields).strict();
const editCategorySchema = z.object({ id: z.string().uuid("Identifiant de catégorie invalide").optional(), ...categoryFields })
  .strict();

const uniqueNames = (cats: { name: string }[]) =>
  new Set(cats.map((c) => c.name.toLowerCase())).size === cats.length;

const eventFields = {
  name: z.string({ required_error: "Le nom est requis" }).trim().min(2, "Le nom doit contenir au moins 2 caractères")
    .max(140, "140 caractères maximum"),
  description: z.string().trim().max(10_000, "10 000 caractères maximum"),
  venue: z.string({ required_error: "Le lieu est requis" }).trim().min(1, "Le lieu est requis").max(160, "160 caractères maximum"),
  city: z.string({ required_error: "La ville est requise" }).trim().min(1, "La ville est requise").max(80, "80 caractères maximum"),
  startsAt: isoDate,
  endsAt: isoDate,
  // http(s) uniquement : "javascript:" ou "data:" permettraient d'injecter du code chez les acheteurs (XSS)
  coverImageUrl: z.string().url("URL d'image invalide").max(2048)
    .refine((u) => /^https?:\/\//i.test(u), "L'URL de l'image doit commencer par https://").nullable(),
};

const createEventSchema = z
  .object({
    ...eventFields,
    description: eventFields.description.default(""),
    coverImageUrl: eventFields.coverImageUrl.optional(),
    categories: z.array(newCategorySchema, { required_error: "Au moins une catégorie est requise" })
      .min(1, "Au moins une catégorie est requise").max(10, "10 catégories maximum")
      .refine(uniqueNames, "Deux catégories ne peuvent pas avoir le même nom"),
  })
  .strict()
  .refine((e) => new Date(e.endsAt) > new Date(e.startsAt), {
    message: "La date de fin doit être après la date de début",
    path: ["endsAt"],
  });

const patchEventSchema = z
  .object({
    ...Object.fromEntries(Object.entries(eventFields).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof eventFields]: z.ZodOptional<(typeof eventFields)[K]>;
    },
    categories: z.array(editCategorySchema).min(1, "Au moins une catégorie est requise").max(10, "10 catégories maximum")
      .refine(uniqueNames, "Deux catégories ne peuvent pas avoir le même nom").optional(),
  })
  .strict()
  .refine((e) => Object.keys(e).length > 0, "Aucun champ à modifier")
  .refine((e) => !e.startsAt || !e.endsAt || new Date(e.endsAt) > new Date(e.startsAt), {
    message: "La date de fin doit être après la date de début",
    path: ["endsAt"],
  });

// --- Accès aux données -------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Renvoie 404 (et non 403) si l'événement appartient à un autre organisateur : on ne révèle pas son existence.
async function getOwnedEvent(id: string, organizerId: string) {
  if (!UUID_RE.test(id)) throw notFound("Événement introuvable");
  const { data, error } = await admin
    .from("events")
    .select("*")
    .eq("id", id)
    .eq("organizer_id", organizerId)
    .maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw notFound("Événement introuvable");
  return data;
}

async function loadEventDetail(id: string, organizerId: string) {
  const event = await getOwnedEvent(id, organizerId);

  const [categories, revenue, scanned] = await Promise.all([
    admin.from("ticket_categories").select("id, name, price_fcfa, quantity, sold, position")
      .eq("event_id", id).order("position"),
    admin.from("orders").select("total_amount").eq("event_id", id).eq("status", "PAID"),
    admin.from("tickets").select("id", { count: "exact", head: true }).eq("event_id", id).eq("status", "SCANNED"),
  ]);
  for (const r of [categories, revenue, scanned]) if (r.error) throw fromDbError(r.error);

  const cats = (categories.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    priceFcfa: c.price_fcfa,
    quantity: c.quantity,
    sold: c.sold,
    remaining: c.quantity - c.sold,
  }));
  const capacity = cats.reduce((s, c) => s + c.quantity, 0);
  const ticketsSold = cats.reduce((s, c) => s + c.sold, 0);

  return {
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
    staffCode: event.staff_code,
    publishedAt: event.published_at,
    createdAt: event.created_at,
    updatedAt: event.updated_at,
    categories: cats,
    stats: {
      capacity,
      ticketsSold,
      revenue: (revenue.data ?? []).reduce((s, o) => s + o.total_amount, 0),
      fillRate: capacity === 0 ? 0 : Math.round((ticketsSold * 1000) / capacity) / 10,
      scannedCount: scanned.count ?? 0,
    },
  };
}

// --- Routes ------------------------------------------------------------------

export const eventRoutes = new Hono<AppEnv>();
eventRoutes.use("*", requireOrganizer);

eventRoutes.get("/", async (c) => {
  const { data, error } = await admin.rpc("list_organizer_events", { p_organizer_id: c.get("user").id });
  if (error) throw fromDbError(error);
  return c.json({ events: data });
});

eventRoutes.post("/", async (c) => {
  const body = await parseJson(c, createEventSchema);
  const { categories, ...event } = body;
  const organizerId = c.get("user").id;

  // Le suffixe aléatoire rend une collision très improbable ; on réessaie malgré tout.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: id, error } = await admin.rpc("create_event", {
      p_organizer_id: organizerId,
      p_slug: generateSlug(event.name),
      p_event: event,
      p_categories: categories,
    });
    if (!error) return c.json({ event: await loadEventDetail(id, organizerId) }, 201);
    if (error.code !== "23505") throw fromDbError(error);
  }
  throw new ApiError(500, "INTERNAL_ERROR", "Impossible de générer un lien unique, réessayez");
});

eventRoutes.get("/:id", async (c) => {
  return c.json({ event: await loadEventDetail(c.req.param("id"), c.get("user").id) });
});

eventRoutes.patch("/:id", async (c) => {
  const organizerId = c.get("user").id;
  const event = await getOwnedEvent(c.req.param("id"), organizerId);
  const { categories, ...patch } = await parseJson(c, patchEventSchema);

  const { error } = await admin.rpc("update_event", {
    p_event_id: event.id,
    p_organizer_id: organizerId,
    p_patch: patch,
    p_categories: categories ?? null,
  });
  if (error) throw fromDbError(error);
  return c.json({ event: await loadEventDetail(event.id, organizerId) });
});

eventRoutes.post("/:id/publish", async (c) => {
  const organizerId = c.get("user").id;
  const event = await getOwnedEvent(c.req.param("id"), organizerId);

  const { data: slug, error } = await admin.rpc("publish_event", { p_event_id: event.id, p_organizer_id: organizerId });
  if (error) throw fromDbError(error);
  return c.json({
    slug,
    publicUrl: `${env.publicAppUrl}/events/${slug}`,
    event: await loadEventDetail(event.id, organizerId),
  });
});

// Ferme la billetterie (statut CLOSED) : plus aucune commande acceptée (PRD §7).
eventRoutes.post("/:id/close", async (c) => {
  const organizerId = c.get("user").id;
  const event = await getOwnedEvent(c.req.param("id"), organizerId);

  const { error } = await admin.rpc("close_event", { p_event_id: event.id, p_organizer_id: organizerId });
  if (error) throw fromDbError(error);
  return c.json({ event: await loadEventDetail(event.id, organizerId) });
});

// Statistiques temps réel du dashboard (US-07) — appelée en polling toutes les 10 s par le front.
eventRoutes.get("/:id/stats", async (c) => {
  const event = await getOwnedEvent(c.req.param("id"), c.get("user").id);
  const { data, error } = await admin.rpc("event_stats", { p_event_id: event.id });
  if (error) throw fromDbError(error);
  c.header("Cache-Control", "no-store");
  return c.json({ stats: data });
});

// --- Commandes de l'événement (US-08) ------------------------------------------

const ORDER_SELECT = `
  id, status, buyer_name, buyer_phone, buyer_email, total_amount, payment_provider, payment_reference,
  failure_reason, created_at, paid_at,
  items:order_items ( quantity, unit_price_fcfa, category:ticket_categories ( name, position ) )
`;

// deno-lint-ignore no-explicit-any
function toOrderRow(o: any) {
  // deno-lint-ignore no-explicit-any
  const items = (o.items as any[])
    .sort((a, b) => a.category.position - b.category.position)
    .map((i) => ({ categoryName: i.category.name, quantity: i.quantity, unitPriceFcfa: i.unit_price_fcfa }));
  return {
    id: o.id,
    status: o.status,
    buyerName: o.buyer_name,
    buyerPhone: o.buyer_phone,
    buyerEmail: o.buyer_email,
    paymentProvider: o.payment_provider,
    paymentReference: o.payment_reference,
    totalAmount: o.total_amount,
    ticketCount: items.reduce((s, i) => s + i.quantity, 0),
    summary: items.map((i) => `${i.quantity}× ${i.categoryName}`).join(", "),
    items,
    failureReason: o.failure_reason,
    createdAt: o.created_at,
    paidAt: o.paid_at,
  };
}

const ordersQuerySchema = z.object({
  page: z.coerce.number().int().min(1, "page doit être ≥ 1").default(1),
  pageSize: z.coerce.number().int().min(1).max(100, "pageSize maximum : 100").default(20),
  status: z.enum(["PAID", "PENDING", "FAILED"], { errorMap: () => ({ message: "Statut invalide (PAID, PENDING ou FAILED)" }) })
    .optional(),
});

eventRoutes.get("/:id/orders", async (c) => {
  const event = await getOwnedEvent(c.req.param("id"), c.get("user").id);
  const parsed = ordersQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, "VALIDATION_ERROR", issue.message, issue.path.join(".") || undefined);
  }
  const { page, pageSize, status } = parsed.data;

  let query = admin.from("orders").select(ORDER_SELECT, { count: "exact" }).eq("event_id", event.id);
  if (status) query = query.eq("status", status);
  const from = (page - 1) * pageSize;
  const { data, count, error } = await query.order("created_at", { ascending: false }).range(from, from + pageSize - 1);

  let total = count ?? 0;
  let rows = data ?? [];
  if (error?.code === "PGRST103") {
    // Page au-delà de la dernière commande : liste vide + vrai total (au lieu d'une erreur)
    let countQuery = admin.from("orders").select("id", { count: "exact", head: true }).eq("event_id", event.id);
    if (status) countQuery = countQuery.eq("status", status);
    const { count: realCount, error: countError } = await countQuery;
    if (countError) throw fromDbError(countError);
    total = realCount ?? 0;
    rows = [];
  } else if (error) {
    throw fromDbError(error);
  }

  c.header("Cache-Control", "no-store");
  return c.json({
    orders: rows.map(toOrderRow),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

// Neutralise l'injection de formules (=, +, -, @, tabulation, retour chariot en tête de cellule)
// puis échappe les guillemets. Séparateur ";" : celui d'Excel en français.
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const frDate = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Africa/Porto-Novo",
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

eventRoutes.get("/:id/orders/export.csv", async (c) => {
  const event = await getOwnedEvent(c.req.param("id"), c.get("user").id);

  // Lecture par paquets de 1000 (limite par requête de l'API Supabase)
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("orders").select(ORDER_SELECT)
      .eq("event_id", event.id).eq("status", "PAID")
      .order("paid_at", { ascending: true }).range(from, from + 999);
    if (error) throw fromDbError(error);
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const header = ["Référence", "Nom", "Téléphone (WhatsApp)", "Email", "Opérateur", "Tickets", "Nombre de tickets",
    "Montant (FCFA)", "Payé le (heure de Cotonou)"];
  const lines = rows.map(toOrderRow).map((o) => [
    o.paymentReference, o.buyerName, o.buyerPhone, o.buyerEmail, o.paymentProvider.toUpperCase(), o.summary,
    o.ticketCount, o.totalAmount, o.paidAt ? frDate.format(new Date(o.paidAt)) : "",
  ].map(csvCell).join(";"));

  const csv = "﻿" + [header.map(csvCell).join(";"), ...lines].join("\r\n") + "\r\n";
  const filename = `acheteurs-${event.slug.replace(/-[a-z0-9]{4}$/, "")}.csv`;
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
});

// Génère un nouveau code staff + PIN (US-09). Le PIN n'est montré qu'une seule fois.
eventRoutes.post("/:id/staff-code", async (c) => {
  const organizerId = c.get("user").id;
  const event = await getOwnedEvent(c.req.param("id"), organizerId);

  const { data, error } = await admin.rpc("rotate_staff_code", { p_event_id: event.id, p_organizer_id: organizerId });
  if (error) throw fromDbError(error);

  const { code, pin } = data as { code: string; pin: string };
  c.header("Cache-Control", "no-store");
  return c.json({ code, pin, scannerUrl: `${env.publicAppUrl}/scanner` }, 201);
});

eventRoutes.delete("/:id", async (c) => {
  const event = await getOwnedEvent(c.req.param("id"), c.get("user").id);

  const { count, error } = await admin.from("orders").select("id", { count: "exact", head: true })
    .eq("event_id", event.id).eq("status", "PAID");
  if (error) throw fromDbError(error);
  if ((count ?? 0) > 0) {
    throw new ApiError(409, "EVENT_HAS_SALES", "Impossible de supprimer un événement qui a déjà vendu des tickets");
  }

  const { error: delError } = await admin.from("events").delete().eq("id", event.id);
  if (delError) throw fromDbError(delError);
  return c.body(null, 204);
});
