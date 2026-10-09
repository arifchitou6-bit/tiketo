// Commandes acheteur (PRD §6.4) — sans authentification.

import { Hono } from "hono";
import { z } from "zod";
import { env } from "../lib/env.ts";
import { ApiError, fromDbError, notFound } from "../lib/errors.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { emailSchema, nameSchema, parseJson } from "../lib/validation.ts";

// Une commande non payée expire au bout de 15 minutes (PRD §7)
export const ORDER_TTL_MINUTES = 15;

const createOrderSchema = z
  .object({
    eventSlug: z.string({ required_error: "eventSlug est requis" }).trim().toLowerCase().min(1).max(80),
    items: z
      .array(
        z.object({
          categoryId: z.string({ required_error: "categoryId est requis" }).uuid("Identifiant de catégorie invalide"),
          quantity: z.number({ required_error: "La quantité est requise", invalid_type_error: "La quantité doit être un nombre" })
            .int("La quantité doit être un entier").min(1, "Au moins 1 ticket").max(20, "20 tickets maximum par commande"),
        }).strict(),
        { required_error: "Le panier est requis" },
      )
      .min(1, "Le panier est vide")
      .max(10, "10 lignes maximum"),
    buyer: z
      .object({
        name: nameSchema,
        // Les espaces, points, tirets et parenthèses sont retirés : "+229 97 00 00 00" -> "+22997000000"
        phone: z.string({ required_error: "Le numéro WhatsApp est requis" })
          .transform((v) => v.replace(/[\s.\-()]/g, ""))
          .pipe(z.string().regex(/^\+?[0-9]{8,15}$/, "Numéro de téléphone invalide")),
        email: z.union([z.literal(""), emailSchema]).optional().transform((v) => v || undefined),
        provider: z.enum(["mtn", "moov", "celtiis"], {
          errorMap: () => ({ message: "Opérateur invalide (mtn, moov ou celtiis)" }),
        }),
      }, { required_error: "Les informations de l'acheteur sont requises" })
      .strict(),
  })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Charge une commande au format de l'API (camelCase)
export async function loadOrder(id: string) {
  if (!UUID_RE.test(id)) throw notFound("Commande introuvable");
  const { data, error } = await admin
    .from("orders")
    .select(`
      id, status, buyer_name, buyer_phone, buyer_email, total_amount, payment_provider, payment_reference,
      failure_reason, created_at, paid_at,
      event:events ( id, slug, name, category, venue, city, country, time_zone, starts_at, ends_at, cover_image_url, cover_fit ),
      items:order_items ( quantity, unit_price_fcfa, category:ticket_categories ( id, name ) )
    `)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw notFound("Commande introuvable");

  // deno-lint-ignore no-explicit-any
  const event = data.event as any;
  return {
    id: data.id,
    status: data.status,
    buyerName: data.buyer_name,
    buyerPhone: data.buyer_phone,
    buyerEmail: data.buyer_email,
    totalAmount: data.total_amount,
    paymentProvider: data.payment_provider,
    paymentReference: data.payment_reference,
    failureReason: data.failure_reason,
    createdAt: data.created_at,
    expiresAt: new Date(new Date(data.created_at).getTime() + ORDER_TTL_MINUTES * 60_000).toISOString(),
    paidAt: data.paid_at,
    event: {
      id: event.id,
      slug: event.slug,
      name: event.name,
      category: event.category,
      venue: event.venue,
      city: event.city,
      country: event.country,
      timeZone: event.time_zone,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      coverImageUrl: event.cover_image_url,
      coverFit: event.cover_fit,
    },
    // deno-lint-ignore no-explicit-any
    items: (data.items as any[]).map((i) => ({
      categoryId: i.category.id,
      categoryName: i.category.name,
      quantity: i.quantity,
      unitPriceFcfa: i.unit_price_fcfa,
      subtotal: i.quantity * i.unit_price_fcfa,
    })),
  };
}

// Tickets d'une commande payée, avec le contenu du QR et le lien vers son image PNG
export async function loadTickets(orderId: string) {
  const { data, error } = await admin
    .from("tickets")
    .select("id, holder_name, qr_payload, status, scanned_at, created_at, category:ticket_categories ( id, name, position )")
    .eq("order_id", orderId)
    .order("created_at");
  if (error) throw fromDbError(error);
  // deno-lint-ignore no-explicit-any
  return (data as any[])
    .sort((a, b) => a.category.position - b.category.position)
    .map((t) => ({
      id: t.id,
      categoryId: t.category.id,
      categoryName: t.category.name,
      holderName: t.holder_name,
      qrPayload: t.qr_payload,
      qrUrl: `${env.apiPublicUrl}/tickets/${t.id}/qr.png`,
      status: t.status,
      scannedAt: t.scanned_at,
    }));
}

const PAYMENT_FAILURES: Record<string, string> = {
  ORDER_EXPIRED: "Le délai de paiement de 15 minutes est dépassé, recommencez votre commande",
  EVENT_CLOSED: "La billetterie de cet événement est fermée",
  SOLD_OUT: "Il ne reste plus assez de tickets : votre commande n'a pas pu être validée",
  FAILED: "Le paiement a échoué",
};

export const orderRoutes = new Hono<AppEnv>();

// 60/min par IP : les opérateurs mobiles partagent souvent une même IP entre de nombreux abonnés (CGNAT)
orderRoutes.post("/", rateLimit("orders", 60), async (c) => {
  const body = await parseJson(c, createOrderSchema);

  const { data: orderId, error } = await admin.rpc("create_order", {
    p_slug: body.eventSlug,
    p_items: body.items,
    p_buyer: body.buyer,
  });
  if (error) throw fromDbError(error);

  const order = await loadOrder(orderId);
  return c.json({
    order,
    paymentUrl: `${env.publicAppUrl}/events/${order.event.slug}/checkout/pay?orderId=${order.id}`,
  }, 201);
});

// Paiement Mobile Money simulé (PRD §6.4) : appelé par l'écran de paiement après 3 secondes.
orderRoutes.post("/:id/simulate-payment", rateLimit("payment", 120), async (c) => {
  const order = await loadOrder(c.req.param("id"));

  const { data, error } = await admin.rpc("pay_order", { p_order_id: order.id, p_ttl_minutes: ORDER_TTL_MINUTES });
  if (error) throw fromDbError(error);

  const result = data as { status: "PAID" | "FAILED"; reason?: string };
  if (result.status === "FAILED") {
    const reason = result.reason ?? "FAILED";
    throw new ApiError(409, reason, PAYMENT_FAILURES[reason] ?? PAYMENT_FAILURES.FAILED);
  }

  return c.json({ order: await loadOrder(order.id), tickets: await loadTickets(order.id) });
});

// Détail d'une commande (PRD §6.4) — accessible sans authentification via le lien direct.
// Vérification paresseuse (PRD §7) : une commande PENDING de plus de 15 min passe en FAILED à la lecture.
orderRoutes.get("/:id", async (c) => {
  let order = await loadOrder(c.req.param("id"));

  if (order.status === "PENDING" && new Date(order.expiresAt).getTime() <= Date.now()) {
    const { error } = await admin
      .from("orders")
      .update({ status: "FAILED", failure_reason: "ORDER_EXPIRED" })
      .eq("id", order.id)
      .eq("status", "PENDING"); // ne touche pas une commande payée entre-temps
    if (error) throw fromDbError(error);
    order = await loadOrder(order.id);
  }

  const tickets = order.status === "PAID" ? await loadTickets(order.id) : [];
  c.header("Cache-Control", "no-store");
  return c.json({ order, tickets });
});
