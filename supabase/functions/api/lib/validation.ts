import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "./errors.ts";

// Messages par défaut en français pour toutes les validations Zod sans message explicite
// (sinon Zod renvoie de l'anglais : "String must contain at most 80 character(s)").
const plural = (n: number | bigint, word: string) => `${n} ${word}${Number(n) > 1 ? "s" : ""}`;
const TYPES: Record<string, string> = {
  string: "un texte", number: "un nombre", integer: "un entier", boolean: "un booléen", array: "une liste",
  object: "un objet", date: "une date", null: "null", undefined: "absent",
};

z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined") return { message: "Ce champ est requis" };
      return { message: `Type invalide : ${TYPES[issue.expected] ?? issue.expected} attendu` };
    case z.ZodIssueCode.too_small: {
      const m = issue.minimum;
      if (issue.type === "string") return { message: m === 1 ? "Ce champ ne peut pas être vide" : `${plural(m, "caractère")} minimum` };
      if (issue.type === "array") return { message: m === 1 ? "La liste ne peut pas être vide" : `${plural(m, "élément")} minimum` };
      if (issue.type === "number") return { message: `La valeur doit être ${issue.inclusive ? "supérieure ou égale" : "supérieure"} à ${m}` };
      break;
    }
    case z.ZodIssueCode.too_big: {
      const m = issue.maximum;
      if (issue.type === "string") return { message: `${plural(m, "caractère")} maximum` };
      if (issue.type === "array") return { message: `${plural(m, "élément")} maximum` };
      if (issue.type === "number") return { message: `La valeur doit être ${issue.inclusive ? "inférieure ou égale" : "inférieure"} à ${m}` };
      break;
    }
    case z.ZodIssueCode.invalid_string: {
      const v = issue.validation;
      if (v === "email") return { message: "Email invalide" };
      if (v === "url") return { message: "URL invalide" };
      if (v === "uuid") return { message: "Identifiant invalide" };
      if (v === "datetime") return { message: "Date au format ISO 8601 attendue (ex. 2026-12-31T20:00:00Z)" };
      return { message: "Format invalide" };
    }
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valeur invalide (valeurs possibles : ${issue.options.join(", ")})` };
    case z.ZodIssueCode.not_finite:
    case z.ZodIssueCode.invalid_date:
      return { message: "Valeur invalide" };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Champ non autorisé : ${issue.keys.join(", ")}` };
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.custom:
      return { message: "Valeur invalide" };
  }
  return { message: ctx.defaultError };
});

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

// Numéro WhatsApp / Mobile Money : espaces, points, tirets et parenthèses retirés
// ("+229 01 97 00 12 34" → "+2290197001234", PRD v2.1 §8.7)
export const phoneSchema = z.string({ required_error: "Le numéro est requis" })
  .transform((v) => v.replace(/[\s.\-()]/g, ""))
  .pipe(z.string().regex(/^\+?[0-9]{8,15}$/, "Numéro de téléphone invalide"));

export const nameSchema = z
  .string({ required_error: "Le nom est requis" })
  .trim()
  .min(2, "Le nom doit contenir au moins 2 caractères")
  .max(120, "Le nom ne peut pas dépasser 120 caractères");
