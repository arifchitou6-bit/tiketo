// TICKETO — API REST (Supabase Edge Function `api`)
// URL de base : https://<ref>.supabase.co/functions/v1/api  (local : http://127.0.0.1:54321/functions/v1/api)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { rejectIfTooLarge } from "./lib/body.ts";
import { env } from "./lib/env.ts";
import { ApiError, errorResponse } from "./lib/errors.ts";
import { admin } from "./lib/supabase.ts";
import type { AppEnv } from "./lib/types.ts";
import { authRoutes } from "./routes/auth.ts";
import { buyerRoutes } from "./routes/buyer.ts";
import { eventRoutes } from "./routes/events.ts";
import { orderRoutes } from "./routes/orders.ts";
import { publicRoutes } from "./routes/public.ts";
import { scanRoutes } from "./routes/scan.ts";
import { staffRoutes } from "./routes/staff.ts";
import { ticketRoutes } from "./routes/tickets.ts";
import { uploadRoutes } from "./routes/uploads.ts";

// Supabase transmet le chemin préfixé par le nom de la fonction : /api/...
const app = new Hono<AppEnv>().basePath("/api");

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (env.allowedOrigins.length === 0) return origin || "*";
      return env.allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    exposeHeaders: ["Content-Disposition", "Retry-After"],
    maxAge: 86400,
  }),
);

// Journal d'accès : méthode, chemin, statut, durée. Jamais de corps de requête ni d'en-tête d'auth.
app.use("*", async (c, next) => {
  const start = performance.now();
  await next();
  const ms = Math.round(performance.now() - start);
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  c.header("X-Content-Type-Options", "nosniff");
});

// Méthode non prévue sur une route existante (ex. PUT /events) : 405 + en-tête Allow,
// avant toute authentification (sinon la réponse serait un 401 trompeur).
let routeTable: { re: RegExp; method: string }[] | null = null;
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const table = routeTable ??= app.routes.filter((r) => r.method !== "ALL").map((r) => ({
    method: r.method,
    re: new RegExp(`^${r.path.replace(/[.]/g, "\\.").replace(/:[^/]+/g, "[^/]+")}$`),
  }));
  const matching = table.filter((r) => r.re.test(c.req.path));
  const allowed = [...new Set(matching.map((r) => r.method))];
  if (allowed.length > 0 && !allowed.includes(c.req.method) && !(c.req.method === "HEAD" && allowed.includes("GET"))) {
    c.header("Allow", allowed.join(", "));
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `Méthode ${c.req.method} non autorisée sur cette route (${allowed.join(", ")})`);
  }
  await next();
});

// Corps JSON limités à 1 Mo (le plus gros envoi légitime, un lot de 500 scans, pèse environ 150 Ko).
// Les images de couverture ont leur propre limite de 5 Mo (routes/uploads.ts).
app.use("*", async (c, next) => {
  if (!c.req.path.startsWith("/api/uploads/")) {
    await rejectIfTooLarge(c, 1024 * 1024, "Requête trop volumineuse (1 Mo maximum)");
  }
  await next();
});

app.get("/health", async (c) => {
  const { error } = await admin.from("events").select("id", { head: true }).limit(1);
  if (error) {
    console.error("[health] base injoignable", { code: error.code });
    return c.json({ ok: false, db: "down" }, 503);
  }
  return c.json({ ok: true, db: "up", time: new Date().toISOString() });
});

app.route("/auth", authRoutes);
app.route("/events", eventRoutes);
app.route("/uploads", uploadRoutes);
app.route("/public", publicRoutes);
app.route("/orders", orderRoutes);
app.route("/tickets", ticketRoutes);
app.route("/staff", staffRoutes);
app.route("/scan", scanRoutes);
app.route("/buyer", buyerRoutes);

app.notFound((c) => errorResponse(c, new ApiError(404, "NOT_FOUND", "Route introuvable")));

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err);
  if (err instanceof HTTPException) {
    return errorResponse(c, new ApiError(err.status, "HTTP_ERROR", err.message || "Requête invalide"));
  }
  console.error("[api] erreur non gérée", { name: err.name, message: err.message });
  return errorResponse(c, new ApiError(500, "INTERNAL_ERROR", "Une erreur interne est survenue"));
});

Deno.serve(app.fetch);
