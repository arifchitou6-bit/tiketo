// Outils communs aux tests d'intégration de l'API TICKETO.
//
// Variables d'environnement :
//   API_URL       URL de l'API     (défaut : http://127.0.0.1:54321/functions/v1/api)
//   DATABASE_URL  accès Postgres   (défaut : base locale Supabase)
//
// Chaque fichier de test crée ses propres comptes (emails t-<run>-…@example.com) et les supprime
// à la fin : la suppression d'un compte efface en cascade ses événements, commandes, tickets et scans.

import pg from "pg";

export const API = (process.env.API_URL ?? "http://127.0.0.1:54321/functions/v1/api").replace(/\/$/, "");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "motdepasse-test-123";

export async function sql(query, params = []) {
  return (await pool.query(query, params)).rows;
}

// Appel HTTP : renvoie { status, body (JSON ou texte), headers }
export async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch { /* corps non JSON (CSV…) */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

// Attend que l'API réponde vite 3 fois d'affilée (en local, l'Edge Function peut être en recompilation)
export async function waitForApi() {
  let ok = 0;
  for (let i = 0; i < 90 && ok < 3; i++) {
    const t = Date.now();
    try {
      const r = await fetch(API + "/health");
      ok = r.status === 200 && Date.now() - t < 2000 ? ok + 1 : 0;
    } catch {
      ok = 0;
    }
    if (ok < 3) await new Promise((r) => setTimeout(r, 1000));
  }
  if (ok < 3) throw new Error(`API injoignable : ${API}`);
}

export async function resetRateLimits() {
  await sql("delete from public.rate_limits");
}

// Attend le début d'une fenêtre de rate limiting (minute calendaire) selon l'horloge DU SERVEUR :
// celle du poste de test peut être décalée. Ne fait rien s'il reste au moins `minSeconds` dans la minute.
export async function waitForFreshMinute(minSeconds = 50) {
  const { time } = await (await fetch(`${API}/health`)).json();
  const ms = new Date(time).getTime() % 60000;
  if (60 - ms / 1000 < minSeconds) await new Promise((r) => setTimeout(r, 60000 - ms + 300));
  await resetRateLimits();
}

export async function setup() {
  await waitForApi();
  await resetRateLimits();
}

export async function cleanup() {
  await sql("delete from auth.users where email like $1", [`t-${RUN}-%@example.com`]);
  await pool.end();
}

// --- Fabriques de données ------------------------------------------------------

export async function createOrganizer(label = "orga") {
  const email = `t-${RUN}-${label}@example.com`;
  const r = await api("POST", "/auth/signup", { body: { email, password: PASSWORD, name: `Test ${label}` } });
  if (r.status !== 201) throw new Error(`signup ${label} : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return { email, password: PASSWORD, token: r.body.session.accessToken, refreshToken: r.body.session.refreshToken, user: r.body.user };
}

export const DEFAULT_CATEGORIES = [
  { name: "Standard", priceFcfa: 5000, quantity: 200 },
  { name: "VIP", priceFcfa: 15000, quantity: 20 },
];

export function futureDates(daysAhead = 30, hours = 6) {
  const start = new Date(Date.now() + daysAhead * 86400000);
  start.setUTCMinutes(0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * 3600000).toISOString() };
}

export async function createEvent(token, overrides = {}) {
  const r = await api("POST", "/events", {
    token,
    body: { name: "Soirée Test", category: "SOIREE", venue: "Le Code Bar", city: "Cotonou", ...futureDates(), categories: DEFAULT_CATEGORIES, ...overrides },
  });
  if (r.status !== 201) throw new Error(`createEvent : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.event;
}

export async function createPublishedEvent(token, overrides = {}) {
  const event = await createEvent(token, overrides);
  const r = await api("POST", `/events/${event.id}/publish`, { token });
  if (r.status !== 200) throw new Error(`publish : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.event;
}

export const BUYER = { name: "Aïcha K.", phone: "+22997000000", provider: "mtn" };

export async function createOrder(slug, items, buyer = BUYER) {
  const r = await api("POST", "/orders", { body: { eventSlug: slug, items, buyer } });
  if (r.status !== 201) throw new Error(`createOrder : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.order;
}

export async function buyTickets(slug, items, buyer = BUYER) {
  const order = await createOrder(slug, items, buyer);
  const r = await api("POST", `/orders/${order.id}/simulate-payment`);
  if (r.status !== 200) throw new Error(`paiement : HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body; // { order, tickets }
}

export async function staffAccess(organizerToken, eventId) {
  const code = await api("POST", `/events/${eventId}/staff-code`, { token: organizerToken });
  const login = await api("POST", "/staff/login", { body: { code: code.body.code, pin: code.body.pin } });
  if (login.status !== 200) throw new Error(`staff login : HTTP ${login.status} ${JSON.stringify(login.body)}`);
  return { code: code.body.code, pin: code.body.pin, token: login.body.token, login: login.body };
}
