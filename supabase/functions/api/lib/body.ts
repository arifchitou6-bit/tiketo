// Refus des corps de requête trop volumineux.
// Le flux est lu jusqu'au bout SANS être décodé avant de répondre : répondre avant la fin de l'envoi
// fait échouer la passerelle Supabase (504), et le client ne verrait jamais l'erreur 413.

import type { Context } from "hono";
import { ApiError } from "./errors.ts";

export async function rejectIfTooLarge(c: Context, maxBytes: number, message: string, field?: string) {
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared <= maxBytes) return;
  const reader = c.req.raw.body?.getReader();
  if (reader) while (!(await reader.read()).done) { /* vidage */ }
  throw new ApiError(413, field ? "FILE_TOO_LARGE" : "PAYLOAD_TOO_LARGE", message, field);
}
