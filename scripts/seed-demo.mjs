#!/usr/bin/env node
// TICKETO — données de démonstration, créées en passant par l'API (comme un vrai utilisateur).
//
// Usage :
//   node scripts/seed-demo.mjs
//   API_URL=https://<ref>.supabase.co/functions/v1/api DEMO_PASSWORD='…' node scripts/seed-demo.mjs
//
// Crée : 1 organisateur, 2 événements publiés avec affiche, 5 catégories, 20 tickets vendus, 5 entrées scannées,
// puis affiche les identifiants, le code staff et le PIN.
// Refuse de s'exécuter si le compte de démo a déjà des événements (pas de doublons).
// Ensuite : `npm run demo:snapshot` pour que la remise à zéro nocturne restaure cet état.

import { readFile } from "node:fs/promises";

const API_URL = (process.env.API_URL ?? "http://127.0.0.1:54321/functions/v1/api").replace(/\/$/, "");
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@ticketo.bj";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "TicketoDemo2026!";
const DEMO_NAME = "Marc Dossou — Afro Vibes";

const DAY = 24 * 3600 * 1000;
// Dates calées sur un samedi soir à venir (20h heure de Cotonou = 19h UTC)
function nextSaturdayAt(daysAhead, hourUtc) {
  const d = new Date(Date.now() + daysAhead * DAY);
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7));
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${method} ${path} → HTTP ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`);
    err.status = res.status;
    err.code = json?.error?.code;
    throw err;
  }
  return json;
}

async function getOrganizerToken() {
  try {
    const { session } = await api("POST", "/auth/signup", { body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME } });
    console.log(`✔ Compte organisateur créé : ${DEMO_EMAIL}`);
    return session.accessToken;
  } catch (e) {
    if (e.code !== "EMAIL_TAKEN") throw e;
    const { session } = await api("POST", "/auth/login", { body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    console.log(`✔ Compte organisateur existant : ${DEMO_EMAIL}`);
    return session.accessToken;
  }
}

// Affiche envoyée comme le ferait le front ; sans Storage (ex. local allégé), l'événement est créé sans affiche
async function uploadCover(token, file) {
  try {
    const bytes = await readFile(new URL(`./assets/${file}`, import.meta.url));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/jpeg" }), file);
    const res = await fetch(`${API_URL}/uploads/cover`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).url;
  } catch (e) {
    console.warn(`⚠ Affiche non envoyée (${file}) : ${e.message}`);
    return undefined;
  }
}

const EVENTS = [
  {
    name: "Afro Night Cotonou",
    description:
      "La soirée afrobeats de la saison. Trois DJs, un son calibré pour danser jusqu'au bout de la nuit, " +
      "et une vue sur la lagune. Tenue chic décontractée exigée. Entrée réservée aux plus de 18 ans.",
    venue: "Le Code Bar, Haie Vive",
    city: "Cotonou",
    starts: nextSaturdayAt(7, 19),
    hours: 8,
    cover: "cover-afro-night.jpg",
    categories: [
      { name: "Standard", priceFcfa: 5000, quantity: 300 },
      { name: "VIP", priceFcfa: 15000, quantity: 60 },
      { name: "Table VVIP (6 pers.)", priceFcfa: 150000, quantity: 5 },
    ],
  },
  {
    name: "Jazz sous les étoiles",
    description:
      "Un concert en plein air au cœur de Porto-Novo : quartet jazz, invités surprises et cocktails maison. " +
      "Ouverture des portes à 19h, début du concert à 20h.",
    venue: "Jardin des Plantes et de la Nature",
    city: "Porto-Novo",
    starts: nextSaturdayAt(21, 19),
    hours: 4,
    cover: "cover-jazz.jpg",
    categories: [
      { name: "Pass Solo", priceFcfa: 10000, quantity: 150 },
      { name: "Pass Duo", priceFcfa: 18000, quantity: 60 },
    ],
  },
];

// 20 tickets au total : [événement, catégorie, quantité, acheteur, téléphone, opérateur]
const ORDERS = [
  [0, 0, 2, "Aïcha Kpèdétin", "+22997112233", "mtn"],
  [0, 1, 1, "Koffi Agbèssi", "+22996223344", "moov"],
  [0, 0, 3, "Fèmi Hounkpè", "+22961334455", "mtn"],
  [0, 1, 2, "Rodrigue d'Almeida", "+22995445566", "celtiis"],
  [0, 2, 1, "Grâce Adjovi", "+22997556677", "mtn"],
  [0, 0, 1, "Sènan Gbaguidi", "+22990667788", "moov"],
  [0, 0, 2, "Mariam Bio Tchané", "+22966778899", "mtn"],
  [1, 0, 2, "Jean-Eudes Zinsou", "+22997889900", "celtiis"],
  [1, 1, 1, "Nadège Houngbédji", "+22996990011", "mtn"],
  [1, 0, 3, "Ulrich Adéoti", "+22961001122", "moov"],
  [1, 1, 2, "Carine Sossa", "+22997012345", "mtn"],
];

async function main() {
  console.log(`TICKETO — seed de démonstration\nAPI : ${API_URL}\n`);
  await api("GET", "/health");

  const token = await getOrganizerToken();
  const { events: existing } = await api("GET", "/events", { token });
  if (existing.length > 0) {
    console.error(`\n✘ Le compte ${DEMO_EMAIL} a déjà ${existing.length} événement(s) : seed déjà fait, rien n'est modifié.`);
    process.exit(1);
  }

  const created = [];
  for (const e of EVENTS) {
    const { event } = await api("POST", "/events", {
      token,
      body: {
        name: e.name,
        description: e.description,
        venue: e.venue,
        city: e.city,
        startsAt: e.starts.toISOString(),
        endsAt: new Date(e.starts.getTime() + e.hours * 3600 * 1000).toISOString(),
        coverImageUrl: await uploadCover(token, e.cover),
        categories: e.categories,
      },
    });
    const { publicUrl } = await api("POST", `/events/${event.id}/publish`, { token });
    created.push({ ...event, publicUrl });
    console.log(`✔ Événement publié : ${event.name} (${event.categories.length} catégories)`);
  }

  const tickets = [];
  for (const [evIdx, catIdx, quantity, name, phone, provider] of ORDERS) {
    const ev = created[evIdx];
    const { order } = await api("POST", "/orders", {
      body: { eventSlug: ev.slug, items: [{ categoryId: ev.categories[catIdx].id, quantity }], buyer: { name, phone, provider } },
    });
    const paid = await api("POST", `/orders/${order.id}/simulate-payment`);
    tickets.push(...paid.tickets.map((t) => ({ ...t, eventIdx: evIdx })));
  }
  console.log(`✔ ${ORDERS.length} commandes payées, ${tickets.length} tickets générés`);

  // Code staff pour chaque événement ; 5 entrées scannées sur le premier, étalées sur l'heure passée
  const staff = [];
  for (const ev of created) {
    const { code, pin, scannerUrl } = await api("POST", `/events/${ev.id}/staff-code`, { token });
    staff.push({ code, pin, scannerUrl });
  }
  const { token: staffToken } = await api("POST", "/staff/login", { body: { code: staff[0].code, pin: staff[0].pin } });
  const toScan = tickets.filter((t) => t.eventIdx === 0).slice(0, 5);
  for (const [i, t] of toScan.entries()) {
    await api("POST", "/scan", {
      token: staffToken,
      body: { qrPayload: t.qrPayload, deviceId: "seed-demo", scannedAt: new Date(Date.now() - (50 - i * 10) * 60000).toISOString() },
    });
  }
  console.log(`✔ ${toScan.length} entrées scannées sur « ${created[0].name} »`);

  console.log("\n================ ACCÈS DÉMO ================");
  console.log(`Organisateur : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  created.forEach((ev, i) => {
    console.log(`\n${ev.name}`);
    console.log(`  Page publique : ${ev.publicUrl}`);
    console.log(`  Scanner       : ${staff[i].scannerUrl}  → code ${staff[i].code}  PIN ${staff[i].pin}`);
  });
  console.log("\nExemple de ticket (succès) : " + tickets[0].qrUrl);
  console.log("=============================================");
  console.log("\nÉtape suivante : npm run demo:snapshot (référence de la remise à zéro nocturne)");
}

main().catch((e) => {
  console.error(`\n✘ Échec du seed : ${e.message}`);
  process.exit(1);
});
