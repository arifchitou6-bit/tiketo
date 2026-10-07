// Upload de l'image de couverture d'un événement (Supabase Storage, bucket public `event-covers`).
// Le front envoie un multipart/form-data avec le champ `file`, puis place l'URL renvoyée dans `coverImageUrl`.

import { Hono } from "hono";
import { requireOrganizer } from "../lib/auth.ts";
import { env } from "../lib/env.ts";
import { ApiError } from "../lib/errors.ts";
import { admin } from "../lib/supabase.ts";
import type { AppEnv } from "../lib/types.ts";

const BUCKET = "event-covers";
const MAX_BYTES = 5 * 1024 * 1024;

// Le type est déterminé par la signature binaire du fichier, pas par le nom ni par le type déclaré.
function detectImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use("*", requireOrganizer);

uploadRoutes.post("/cover", async (c) => {
  // Envoi trop gros annoncé : on vide le flux SANS décoder le multipart (décoder 6 Mo dépasse la
  // limite CPU de l'Edge Function), puis on refuse. Le flux est lu jusqu'au bout car répondre
  // avant la fin de l'envoi fait échouer la passerelle (504) : le client ne verrait pas l'erreur.
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) {
    const reader = c.req.raw.body?.getReader();
    if (reader) while (!(await reader.read()).done) { /* vidage */ }
    throw new ApiError(413, "FILE_TOO_LARGE", "L'image ne doit pas dépasser 5 Mo", "file");
  }

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    throw new ApiError(400, "INVALID_BODY", "Envoyez l'image en multipart/form-data (champ « file »)", "file");
  }

  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "Aucune image reçue (champ « file »)", "file");
  }
  if (file.size > MAX_BYTES) {
    throw new ApiError(413, "FILE_TOO_LARGE", "L'image ne doit pas dépasser 5 Mo", "file");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImageType(bytes);
  if (!type) {
    throw new ApiError(415, "UNSUPPORTED_FILE_TYPE", "Formats acceptés : JPEG, PNG ou WebP", "file");
  }

  // Un dossier par organisateur (cohérent avec les politiques Storage de la migration RLS)
  const path = `${c.get("user").id}/${crypto.randomUUID()}.${type.ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: type.mime,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) {
    console.error("[upload] échec Storage", { message: error.message });
    throw new ApiError(502, "UPLOAD_FAILED", "L'image n'a pas pu être enregistrée, réessayez");
  }

  return c.json({ url: `${env.publicSupabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`, path }, 201);
});
