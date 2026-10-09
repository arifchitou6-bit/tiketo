// Accès des agents de porte (PRD §6.6) — connexion par code + PIN, sans compte.

import { Hono } from "hono";
import { z } from "zod";
import { requireStaff, sha256Hex } from "../lib/auth.ts";
import { fromDbError } from "../lib/errors.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { parseJson } from "../lib/validation.ts";

const loginSchema = z
  .object({
    code: z.string({ required_error: "Le code est requis" }).trim().toUpperCase()
      .regex(/^[A-Z0-9]{6}$/, "Le code contient 6 caractères"),
    pin: z.string({ required_error: "Le PIN est requis" }).trim().regex(/^\d{4}$/, "Le PIN contient 4 chiffres"),
    deviceId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

// Index de validation hors ligne : empreinte sha256 de chaque QR valide + infos d'affichage.
// Lecture par pages de 1000 (limite par requête de l'API Supabase).
async function loadTicketIndex(eventId: string) {
  const PAGE = 1000;
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("tickets")
      .select("qr_hash, holder_name, status, scanned_at, category:ticket_categories ( name )")
      .eq("event_id", eventId)
      .neq("status", "INVALIDATED")
      .order("created_at")
      .range(from, from + PAGE - 1);
    if (error) throw fromDbError(error);
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const tickets = rows.map((t) => ({
    hash: t.qr_hash,
    holderName: t.holder_name,
    category: t.category.name,
    status: t.status,
    scannedAt: t.scanned_at,
  }));
  return {
    ticketHashes: tickets.map((t) => t.hash),
    tickets,
    totalTickets: tickets.length,
    scannedCount: tickets.filter((t) => t.status === "SCANNED").length,
    serverTime: new Date().toISOString(),
  };
}

export const staffRoutes = new Hono<AppEnv>();

// 10 essais/min par IP : protège le PIN à 4 chiffres contre les essais en série
staffRoutes.post("/login", rateLimit("staff-login", 10), async (c) => {
  const body = await parseJson(c, loginSchema);

  // Jeton opaque de 256 bits ; seule son empreinte est stockée en base.
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

  const { data, error } = await admin.rpc("staff_login", {
    p_code: body.code,
    p_pin: body.pin,
    p_token_hash: await sha256Hex(token),
    p_device_id: body.deviceId ?? null,
  });
  if (error) throw fromDbError(error);

  const session = data as { eventId: string; eventName: string; venue: string; startsAt: string; endsAt: string; expiresAt: string };
  // Ville et fuseau du lieu : afficher l'heure locale de l'événement sur le scanner
  const { data: place, error: placeError } = await admin.from("events").select("city, time_zone")
    .eq("id", session.eventId).single();
  if (placeError) throw fromDbError(placeError);
  return c.json({ ...session, city: place.city, timeZone: place.time_zone, token, ...(await loadTicketIndex(session.eventId)) });
});

// Rafraîchit l'index hors ligne (tickets vendus après la connexion, scans des autres agents).
staffRoutes.get("/tickets", requireStaff, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await loadTicketIndex(c.get("staff").eventId));
});
