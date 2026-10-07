import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "./errors.ts";

// Lit et valide le corps JSON. En cas d'erreur : 400 { error: { code, message, field } }
// avec le premier champ invalide (ex. "email", "categories.0.priceFcfa").
export async function parseJson<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Le corps de la requête doit être un JSON valide");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue.code === "unrecognized_keys") {
      const key = [...issue.path, issue.keys[0]].join(".");
      throw new ApiError(400, "VALIDATION_ERROR", `Champ non autorisé : ${issue.keys.join(", ")}`, key);
    }
    const field = issue.path.join(".") || undefined;
    throw new ApiError(400, "VALIDATION_ERROR", issue.message, field);
  }
  return result.data;
}

// --- Schémas partagés --------------------------------------------------------

export const emailSchema = z
  .string({ required_error: "L'email est requis" })
  .trim()
  .toLowerCase()
  .max(254, "Email trop long")
  .email("Email invalide");

export const nameSchema = z
  .string({ required_error: "Le nom est requis" })
  .trim()
  .min(2, "Le nom doit contenir au moins 2 caractères")
  .max(120, "Le nom ne peut pas dépasser 120 caractères");
