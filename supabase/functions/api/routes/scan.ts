// Contrôle des entrées (PRD §6.6) — réservé aux agents connectés avec code + PIN.

import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireStaff } from "../lib/auth.ts";
import { fromDbError } from "../lib/errors.ts";
import { rateLimit } from "../lib/rateLimit.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";
import { parseJson } from "../lib/validation.ts";

export const scanInputSchema = z
  .object({
    qrPayload: z.string({ required_error: "qrPayload est requis" }).min(1, "QR vide").max(512, "QR trop long"),
    deviceId: z.string({ required_error: "deviceId est requis" }).trim().min(1).max(100),
    scannedAt: z.string().datetime({ offset: true, message: "Date au format ISO 8601 attendue" }).optional(),
    clientScanId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

// Nombre d'entrées validées pour l'événement (compteur du scanner, US-24)
export async function countScanned(eventId: string) {
  const { count, error } = await admin.from("tickets").select("id", { count: "exact", head: true })
    .eq("event_id", eventId).eq("status", "SCANNED");
  if (error) throw fromDbError(error);
  return count ?? 0;
}

export const scanRoutes = new Hono<AppEnv>();
scanRoutes.use("*", requireStaff);

// Limites comptées PAR AGENT (session staff) et non par IP : les agents d'un même lieu partagent
// souvent la même IP publique (wifi du club). 100 scans/min par agent.
const perAgent = (c: Context<AppEnv>) => `session:${c.get("staff").sessionId}`;

scanRoutes.post("/", rateLimit("scan", 100, 60, perAgent), async (c) => {
  const body = await parseJson(c, scanInputSchema);
  const staff = c.get("staff");

  const { data, error } = await admin.rpc("scan_ticket", {
    p_event_id: staff.eventId,
    p_staff_code: staff.staffCode,
    p_qr_payload: body.qrPayload,
    p_device_id: body.deviceId,
    p_scanned_at: body.scannedAt ?? null,
    p_client_scan_id: body.clientScanId ?? null,
    p_from_sync: false,
  });
  if (error) throw fromDbError(error);

  c.header("Cache-Control", "no-store");
  return c.json({ ...(data as Record<string, unknown>), scannedCount: await countScanned(staff.eventId) });
});

const batchSchema = z
  .object({
    scans: z
      .array(scanInputSchema.extend({
        // Obligatoires pour la synchro : heure réelle du scan + identifiant unique (anti-doublon au renvoi)
        scannedAt: z.string({ required_error: "scannedAt est requis" })
          .datetime({ offset: true, message: "Date au format ISO 8601 attendue" }),
        clientScanId: z.string({ required_error: "clientScanId est requis" }).trim().min(1).max(100),
      }), { required_error: "scans est requis" })
      .min(1, "Le lot est vide")
      .max(500, "500 scans maximum par lot"),
  })
  .strict();

// Synchronisation des scans faits hors ligne (PRD §6.6, US-25)
scanRoutes.post("/batch", rateLimit("scan-batch", 30, 60, perAgent), async (c) => {
  const { scans } = await parseJson(c, batchSchema);
  const staff = c.get("staff");

  const { data, error } = await admin.rpc("scan_batch", {
    p_event_id: staff.eventId,
    p_staff_code: staff.staffCode,
    p_scans: scans,
  });
  if (error) throw fromDbError(error);

  const results = data as { index: number; result: string; replayed?: boolean }[];
  const fresh = results.filter((r) => !r.replayed);
  c.header("Cache-Control", "no-store");
  return c.json({
    results,
    summary: {
      total: results.length,
      ok: fresh.filter((r) => r.result === "OK").length,
      duplicate: fresh.filter((r) => r.result === "DUPLICATE").length,
      invalid: fresh.filter((r) => r.result === "INVALID").length,
      error: fresh.filter((r) => r.result === "ERROR").length,
      alreadySynced: results.length - fresh.length,
    },
    // Scans validés hors ligne mais refusés par le serveur : ticket déjà entré par un autre appareil
    conflicts: fresh.filter((r) => r.result === "DUPLICATE").map((r) => r.index),
    scannedCount: await countScanned(staff.eventId),
    syncedAt: new Date().toISOString(),
  });
});
