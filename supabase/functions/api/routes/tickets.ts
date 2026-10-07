// Image QR d'un ticket (PRD §6.5) — accessible via le lien direct, sans authentification.

import { Hono } from "hono";
import QRCode from "qrcode";
import { fromDbError, notFound } from "../lib/errors.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toFilePart = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 30);

export const ticketRoutes = new Hono<AppEnv>();

ticketRoutes.get("/:id/qr.png", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("Ticket introuvable");

  const { data, error } = await admin
    .from("tickets")
    .select("qr_payload, category:ticket_categories ( name ), event:events ( name )")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw notFound("Ticket introuvable");

  // Niveau de correction "M" (15 %) : bon compromis densité / lisibilité sur écran de téléphone
  const png: Uint8Array = await QRCode.toBuffer(data.qr_payload, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 600,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  // deno-lint-ignore no-explicit-any
  const row = data as any;
  const filename = `ticket-${toFilePart(row.event.name)}-${toFilePart(row.category.name)}-${id.slice(0, 8)}.png`;
  const disposition = c.req.query("download") === "1" ? "attachment" : "inline";

  return c.body(png, 200, {
    "Content-Type": "image/png",
    "Content-Disposition": `${disposition}; filename="${filename}"`,
    // Le contenu d'un QR ne change jamais : cache long
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});
