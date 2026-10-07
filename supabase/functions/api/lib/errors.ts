import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Format d'erreur uniforme (PRD §10) : { error: { code, message, field? } }
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

export const notFound = (message = "Ressource introuvable") => new ApiError(404, "NOT_FOUND", message);
export const unauthorized = (message = "Authentification requise") => new ApiError(401, "UNAUTHORIZED", message);

// Codes métier levés par les fonctions SQL (RAISE EXCEPTION '<CODE>')
const BUSINESS_STATUS: Record<string, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 422,
  VALIDATION_ERROR: 400,
  NO_CATEGORY: 422,
  SOLD_OUT: 409,
  EVENT_CLOSED: 409,
  EVENT_ENDED: 409,
  QUANTITY_BELOW_SOLD: 409,
  CATEGORY_HAS_ORDERS: 409,
  INVALID_CREDENTIALS: 401,
  EVENT_NOT_PUBLISHED: 409,
};

interface PgError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

export function fromDbError(err: PgError): ApiError {
  const code = err.message ?? "";
  if (code in BUSINESS_STATUS) {
    return new ApiError(BUSINESS_STATUS[code], code, err.details || code, err.hint || undefined);
  }
  switch (err.code) {
    case "23514": // check_violation
    case "23502": // not_null_violation
    case "22007": // invalid_datetime_format
    case "22P02": // invalid_text_representation
    case "22001": // string_data_right_truncation
      return new ApiError(400, "VALIDATION_ERROR", "Données invalides");
    case "23505":
      return new ApiError(409, "CONFLICT", "Cette ressource existe déjà");
    case "23503":
      return new ApiError(409, "CONFLICT", "Ressource liée à d'autres données");
  }
  console.error("[db] erreur inattendue", { code: err.code, message: err.message });
  return new ApiError(500, "INTERNAL_ERROR", "Une erreur interne est survenue");
}

export function errorResponse(c: Context, err: ApiError) {
  return c.json(
    { error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) } },
    err.status,
  );
}
