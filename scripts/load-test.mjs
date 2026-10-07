#!/usr/bin/env node
// TICKETO — test de charge du contrôle d'accès.
//
// Scénario : 300 tickets vendus, 4 agents scannent en parallèle pendant DURATION secondes à
// RATE scans/min au total (dont ~8 % de doublons et ~4 % de QR invalides), pendant que
// l'organisateur interroge le dashboard toutes les 10 s ; puis synchro hors ligne d'un lot de 100 scans.
// Vérifie à la fin qu'aucun ticket n'est entré deux fois.
//
// Usage :
//   node scripts/load-test.mjs
//   API_URL=… DATABASE_URL=… RATE=150 DURATION=60 node scripts/load-test.mjs
// DATABASE_URL (optionnel) permet la vérification en base et la suppression des données du test.

import pg from "pg";

const API = (process.env.API_URL ?? "http://127.0.0.1:54321/functions/v1/api").replace(/\/$/, "");
const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RATE = Number(process.env.RATE ?? 150); // scans/min, tous agents confondus
const DURATION = Number(process.env.DURATION ?? 60); // secondes
const AGENTS = 4;
const TICKETS = 300;

const db = new pg.Pool({ connectionString: DB_URL, max: 2 });
const dbAvailable = await db.query("select 1").then(() => true, () => false);

async function api(method, path, { token, body } = {}) {
  const t0 = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non JSON */ }
  return { status: res.status, body: json, ms: performance.now() - t0 };
}
async function must(method, path, opts) {
  const r = await api(method, path, opts);
  if (r.status >= 300) throw new Error(`${method} ${path} → HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const fmt = (arr) => arr.length
  ? `moy ${Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)} ms | médiane ${Math.round(pct(arr, 50))} ms | p95 ${Math.round(pct(arr, 95))} ms | max ${Math.round(Math.max(...arr))} ms`
  : "—";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Préparation -----------------------------------------------------------
console.log(`TICKETO — test de charge\nAPI : ${API}\nObjectif : ${RATE} scans/min pendant ${DURATION} s, ${AGENTS} agents, ${TICKETS} tickets\n`);
if (dbAvailable) await db.query("delete from public.rate_limits");

const email = `load-${Date.now().toString(36)}@example.com`;
const { session } = await must("POST", "/auth/signup", { body: { email, password: "motdepasse-charge-1", name: "Test de charge" } });
const orga = session.accessToken;
const start = new Date(Date.now() + 7 * 86400000);
const { event } = await must("POST", "/events", {
  token: orga,
  body: { name: "Test de charge", venue: "Club", city: "Cotonou", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 6 * 3600000).toISOString(), categories: [{ name: "Standard", priceFcfa: 5000, quantity: 400 }] },
});
await must("POST", `/events/${event.id}/publish`, { token: orga });

const tickets = [];
for (let i = 0; i < TICKETS / 20; i++) {
  const { order } = await must("POST", "/orders", { body: { eventSlug: event.slug, items: [{ categoryId: event.categories[0].id, quantity: 20 }], buyer: { name: `Acheteur ${i}`, phone: `+2299700${String(i).padStart(4, "0")}`, provider: "mtn" } } });
  tickets.push(...(await must("POST", `/orders/${order.id}/simulate-payment`)).tickets);
}
const { code, pin } = await must("POST", `/events/${event.id}/staff-code`, { token: orga });
const agents = [];
for (let i = 0; i < AGENTS; i++) agents.push((await must("POST", "/staff/login", { body: { code, pin, deviceId: `agent-${i + 1}` } })).token);
console.log(`✔ Préparation : ${tickets.length} tickets vendus, ${AGENTS} agents connectés\n`);

// --- Charge -----------------------------------------------------------------
const latencies = [];
const statusCount = {};
const resultCount = {};
const okTickets = new Set();
let queue = [...tickets];
const scannedPayloads = [];

const intervalMs = (60_000 / RATE) * AGENTS; // chaque agent scanne à son rythme
const endAt = Date.now() + DURATION * 1000;
const offline = tickets.slice(-100); // gardés pour la synchro hors ligne
queue = queue.slice(0, -100);

async function agentLoop(i) {
  await sleep(i * (intervalMs / AGENTS)); // décalage des agents
  while (Date.now() < endAt) {
    const roll = Math.random();
    let qr;
    if (roll < 0.04) qr = `TCKT.${crypto.randomUUID()}.faux`;
    else if (roll < 0.12 && scannedPayloads.length) qr = scannedPayloads[Math.floor(Math.random() * scannedPayloads.length)];
    else qr = queue.shift()?.qrPayload ?? scannedPayloads[0];
    const t0 = Date.now();
    const r = await api("POST", "/scan", { token: agents[i], body: { qrPayload: qr, deviceId: `agent-${i + 1}` } });
    latencies.push(r.ms);
    statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;
    if (r.status === 200) {
      resultCount[r.body.result] = (resultCount[r.body.result] ?? 0) + 1;
      if (r.body.result === "OK") { okTickets.add(r.body.ticketId); scannedPayloads.push(qr); }
    }
    await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
  }
}

const statsLatencies = [];
const statsErrors = [];
async function dashboardLoop() {
  while (Date.now() < endAt) {
    const r = await api("GET", `/events/${event.id}/stats`, { token: orga });
    statsLatencies.push(r.ms);
    if (r.status !== 200) statsErrors.push(r.status);
    await sleep(10_000);
  }
}

const progress = setInterval(() => process.stdout.write(`\r  … ${latencies.length} scans envoyés`), 2000);
const t0 = Date.now();
await Promise.all([...agents.map((_, i) => agentLoop(i)), dashboardLoop()]);
clearInterval(progress);
const elapsed = (Date.now() - t0) / 1000;

// --- Synchro hors ligne -----------------------------------------------------
const batch = offline.map((t, i) => ({ qrPayload: t.qrPayload, deviceId: "agent-offline", scannedAt: new Date(Date.now() - (100 - i) * 1000).toISOString(), clientScanId: `off-${i}` }));
const sync = await api("POST", "/scan/batch", { token: agents[0], body: { scans: batch } });

// --- Vérifications ----------------------------------------------------------
const finalStats = await api("GET", `/events/${event.id}/stats`, { token: orga });
const expectedScanned = okTickets.size + (sync.body?.summary?.ok ?? 0);
let doubleEntries = null;
if (dbAvailable) {
  const { rows } = await db.query("select count(*)::int as n from (select ticket_id from scan_events where event_id = $1 and result = 'OK' group by ticket_id having count(*) > 1) x", [event.id]);
  doubleEntries = rows[0].n;
}

console.log(`\r\n================ RÉSULTATS ================`);
console.log(`Scans en ligne        : ${latencies.length} en ${elapsed.toFixed(0)} s → ${(latencies.length / elapsed * 60).toFixed(0)} scans/min`);
console.log(`Statuts HTTP          : ${JSON.stringify(statusCount)}`);
console.log(`Résultats             : ${JSON.stringify(resultCount)}`);
console.log(`Temps de réponse scan : ${fmt(latencies)}`);
console.log(`Dashboard (polling)   : ${statsLatencies.length} appels | ${fmt(statsLatencies)} | erreurs ${statsErrors.length ? JSON.stringify(statsErrors) : "aucune"}`);
console.log(`Synchro hors ligne    : HTTP ${sync.status} en ${Math.round(sync.ms)} ms | ${JSON.stringify(sync.body?.summary ?? sync.body)}`);
console.log(`Cohérence             : compteur ${finalStats.body?.stats?.scannedCount} / tickets entrés attendus ${expectedScanned} ${finalStats.body?.stats?.scannedCount === expectedScanned ? "✔" : "✘"}`);
if (doubleEntries !== null) console.log(`Doubles entrées       : ${doubleEntries} ${doubleEntries === 0 ? "✔" : "✘"}`);
console.log(`===========================================`);

if (dbAvailable) {
  await db.query("delete from auth.users where email = $1", [email]);
  await db.query("delete from public.rate_limits");
  console.log("(données du test supprimées)");
} else {
  console.log(`(base inaccessible : supprimer manuellement le compte ${email})`);
}
await db.end();
