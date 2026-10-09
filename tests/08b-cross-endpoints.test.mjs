// Tests croisés : cohérence entre les routes quand l'état d'un événement change
// (organisateur, pages publiques, likes, commandes, dashboard, CSV, scanner), et finitions de l'API.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { API, api, buyTickets, cleanup, createEvent, createOrder, createOrganizer, createPublishedEvent, resetRateLimits, setup, staffAccess }
  from "./helpers.mjs";

before(async () => {
  await setup();
  await resetRateLimits();
});
after(cleanup);

const TAG = `xc${Date.now().toString(36)}`;
const listed = async (q = TAG) => (await api("GET", `/public/events?q=${encodeURIComponent(q)}`)).body.events;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

describe("Parcours complet : les chiffres concordent sur toutes les routes", () => {
  let orga, ev, std, vip, paid, staff;
  before(async () => {
    orga = await createOrganizer("cross");
    ev = await createPublishedEvent(orga.token, {
      name: `Afro Live ${TAG}`, category: "CONCERT", country: "TG", city: "Lomé", timeZone: "Africa/Lome", coverFit: "contain",
      categories: [{ name: "Standard", priceFcfa: 5000, quantity: 50, description: "Accès général" }, { name: "VIP", priceFcfa: 15000, quantity: 5 }],
    });
    [std, vip] = ev.categories;
  });

  test("publié → visible dans la liste publique et le détail, avec les mêmes valeurs", async () => {
    const [card] = await listed();
    const detail = (await api("GET", `/public/events/${ev.slug}`)).body.event;
    for (const k of ["id", "slug", "name", "category", "country", "city", "timeZone", "coverFit", "startsAt", "likesCount", "minPriceFcfa", "isSoldOut", "isSalesOpen"]) {
      assert.deepEqual(card[k], detail[k], `liste ≠ détail pour ${k}`);
    }
    assert.equal(detail.categories[0].description, "Accès général");
  });

  test("like → même compteur dans la liste, le détail et l'espace organisateur", async () => {
    for (const d of ["appareil-1-xxxx", "appareil-2-xxxx", "appareil-1-xxxx"]) {
      await api("POST", `/public/events/${ev.slug}/like`, { body: { deviceId: d } });
    }
    const counts = [
      (await listed())[0].likesCount,
      (await api("GET", `/public/events/${ev.slug}?deviceId=appareil-1-xxxx`)).body.event.likesCount,
      (await api("GET", `/events/${ev.id}`, { token: orga.token })).body.event.likesCount,
      (await api("GET", "/events", { token: orga.token })).body.events.find((e) => e.id === ev.id).likesCount,
    ];
    assert.deepEqual(counts, [2, 2, 2, 2]);
  });

  test("achat → commande, places restantes, dashboard, liste des commandes et CSV concordent", async () => {
    paid = await buyTickets(ev.slug, [{ categoryId: std.id, quantity: 2 }, { categoryId: vip.id, quantity: 1 }],
      { name: "Kofi Mensah", phone: "+22890112233", provider: "moov" });
    await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]); // panier non payé : ne compte pas

    // Commande (écran de succès) : champs utiles à l'affichage de l'événement
    const order = (await api("GET", `/orders/${paid.order.id}`)).body;
    assert.deepEqual([order.order.status, order.order.totalAmount, order.tickets.length], ["PAID", 25000, 3]);
    assert.deepEqual([order.order.event.category, order.order.event.timeZone, order.order.event.country, order.order.event.coverFit],
      ["CONCERT", "Africa/Lome", "TG", "contain"]);

    // Avec deviceId, le détail public est lu en direct (sans le cache de 30 s des visiteurs anonymes)
    const pub = (await api("GET", `/public/events/${ev.slug}?deviceId=appareil-1-xxxx`)).body.event;
    assert.deepEqual(pub.categories.map((c) => c.remaining), [48, 4]);

    const { stats } = (await api("GET", `/events/${ev.id}/stats`, { token: orga.token })).body;
    assert.deepEqual([stats.ticketsSold, stats.revenue, stats.orders.paid, stats.orders.pending], [3, 25000, 1, 1]);

    const detail = (await api("GET", `/events/${ev.id}`, { token: orga.token })).body.event;
    assert.deepEqual([detail.stats.ticketsSold, detail.stats.revenue], [3, 25000], "détail = stats");
    const card = (await api("GET", "/events", { token: orga.token })).body.events.find((e) => e.id === ev.id);
    assert.deepEqual([card.ticketsSold, card.revenue], [3, 25000], "liste du dashboard = stats");

    const orders = (await api("GET", `/events/${ev.id}/orders?status=PAID`, { token: orga.token })).body;
    assert.deepEqual([orders.pagination.total, orders.orders[0].totalAmount, orders.orders[0].ticketCount], [1, 25000, 3]);

    const csv = (await api("GET", `/events/${ev.id}/orders/export.csv`, { token: orga.token })).body;
    const lines = csv.trim().split("\r\n");
    assert.equal(lines.length, 2, "en-tête + 1 commande payée");
    // "+" en tête neutralisé par une apostrophe (protection contre l'injection de formules dans Excel)
    assert.match(lines[1], /"Kofi Mensah";"'\+22890112233";"";"MOOV";"2× Standard, 1× VIP";"3";"25000"/);
  });

  test("scanner : index hors ligne = tickets vendus ; scan → compteurs à jour partout", async () => {
    staff = await staffAccess(orga.token, ev.id);
    assert.deepEqual([staff.login.timeZone, staff.login.city], ["Africa/Lome", "Lomé"], "heure locale du lieu sur le scanner");
    assert.deepEqual(new Set(staff.login.ticketHashes), new Set(paid.tickets.map((t) => sha256(t.qrPayload))));

    const r = await api("POST", "/scan", { token: staff.token, body: { qrPayload: paid.tickets[0].qrPayload, deviceId: "porte-1" } });
    assert.deepEqual([r.body.result, r.body.scannedCount], ["OK", 1]);

    assert.equal((await api("GET", `/events/${ev.id}/stats`, { token: orga.token })).body.stats.scannedCount, 1);
    assert.equal((await api("GET", `/orders/${paid.order.id}`)).body.tickets.find((t) => t.id === paid.tickets[0].id).status, "SCANNED");
    assert.equal((await api("GET", "/staff/tickets", { token: staff.token })).body.scannedCount, 1);
  });

  test("le prix change après la vente : la commande et la recette gardent le prix payé", async () => {
    const r = await api("PATCH", `/events/${ev.id}`, {
      token: orga.token,
      body: { categories: [{ id: std.id, name: "Standard", priceFcfa: 7000, quantity: 50 }, { id: vip.id, name: "VIP", priceFcfa: 15000, quantity: 5 }] },
    });
    assert.equal(r.status, 200);
    assert.equal((await api("GET", `/orders/${paid.order.id}`)).body.order.totalAmount, 25000);
    assert.equal((await api("GET", `/events/${ev.id}/stats`, { token: orga.token })).body.stats.revenue, 25000);
    assert.equal((await listed())[0].minPriceFcfa, 7000, "nouveau prix affiché publiquement");
  });
});

describe("Changements d'état propagés à toutes les routes", () => {
  let orga;
  before(async () => {
    orga = await createOrganizer("cross-etat");
  });

  test("complet : « Complet » dans la liste et le détail, nouvelle commande refusée", async () => {
    const ev = await createPublishedEvent(orga.token, { name: `Complet ${TAG}`, categories: [{ name: "Unique", priceFcfa: 3000, quantity: 2 }] });
    await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 2 }]);
    const [card] = await listed(`Complet ${TAG}`);
    const detail = (await api("GET", `/public/events/${ev.slug}`)).body.event;
    assert.deepEqual([card.isSoldOut, card.isSalesOpen, detail.isSoldOut, detail.isSalesOpen], [true, false, true, false]);
    assert.equal(card.minPriceFcfa, 3000, "prix affiché même complet");
    const r = await api("POST", "/orders", { body: { eventSlug: ev.slug, items: [{ categoryId: ev.categories[0].id, quantity: 1 }], buyer: { name: "Aïcha", phone: "+22997000000", provider: "mtn" } } });
    assert.deepEqual([r.status, r.body.error.code], [409, "SOLD_OUT"]);
  });

  test("clôture : retiré de la liste, commandes et modifications refusées, la porte continue de scanner", async () => {
    const ev = await createPublishedEvent(orga.token, { name: `Clôture ${TAG}` });
    const { tickets } = await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 2 }]);
    const staff = await staffAccess(orga.token, ev.id);
    assert.equal((await api("POST", `/events/${ev.id}/close`, { token: orga.token })).status, 200);

    assert.deepEqual(await listed(`Clôture ${TAG}`), [], "plus dans l'accueil ni la recherche");
    const detail = (await api("GET", `/public/events/${ev.slug}`)).body.event;
    assert.deepEqual([detail.status, detail.isSalesOpen], ["CLOSED", false], "le lien partagé reste consultable");
    const order = await api("POST", "/orders", { body: { eventSlug: ev.slug, items: [{ categoryId: ev.categories[0].id, quantity: 1 }], buyer: { name: "Aïcha", phone: "+22997000000", provider: "mtn" } } });
    assert.equal(order.body.error.code, "EVENT_CLOSED");
    assert.equal((await api("PATCH", `/events/${ev.id}`, { token: orga.token, body: { name: "Nouveau nom" } })).body.error.code, "EVENT_CLOSED");

    // La billetterie est fermée, pas la porte : les tickets vendus entrent toujours
    assert.equal((await api("POST", "/scan", { token: staff.token, body: { qrPayload: tickets[0].qrPayload, deviceId: "porte" } })).body.result, "OK");
    assert.equal((await api("POST", "/staff/login", { body: { code: staff.code, pin: staff.pin } })).status, 200, "connexion staff toujours possible");
  });

  test("modification : nouveau nom et nouvelle catégorie visibles dans la recherche et les filtres", async () => {
    const ev = await createPublishedEvent(orga.token, { name: `Ancien ${TAG}`, category: "SOIREE" });
    await api("PATCH", `/events/${ev.id}`, { token: orga.token, body: { name: `Gala ${TAG}`, category: "THEATRE" } });
    assert.deepEqual(await listed(`Ancien ${TAG}`), []);
    const found = await listed(`gala ${TAG}`);
    assert.deepEqual(found.map((e) => [e.id, e.category]), [[ev.id, "THEATRE"]]);
    const filtered = (await api("GET", `/public/events?q=${TAG}&category=THEATRE`)).body.events;
    assert.ok(filtered.some((e) => e.id === ev.id));
    assert.equal((await api("GET", `/public/events/${ev.slug}`)).body.event.name, `Gala ${TAG}`, "même slug, nom à jour");
  });

  test("suppression : plus rien n'est accessible (détail, liste, like, commande)", async () => {
    const ev = await createPublishedEvent(orga.token, { name: `Supprimé ${TAG}` });
    await api("POST", `/public/events/${ev.slug}/like`, { body: { deviceId: "appareil-supp-1" } });
    assert.equal((await api("DELETE", `/events/${ev.id}`, { token: orga.token })).status, 204);
    assert.equal((await api("GET", `/public/events/${ev.slug}`)).status, 404);
    assert.deepEqual(await listed(`Supprimé ${TAG}`), []);
    assert.equal((await api("POST", `/public/events/${ev.slug}/like`, { body: { deviceId: "appareil-supp-1" } })).status, 404);
    assert.equal((await api("GET", `/events/${ev.id}`, { token: orga.token })).status, 404);
    const order = await api("POST", "/orders", { body: { eventSlug: ev.slug, items: [{ categoryId: ev.categories[0].id, quantity: 1 }], buyer: { name: "Aïcha", phone: "+22997000000", provider: "mtn" } } });
    assert.equal(order.status, 404);
  });

  test("brouillon : invisible partout côté public", async () => {
    const draft = await createEvent(orga.token, { name: `Brouillon ${TAG}` });
    assert.deepEqual(await listed(`Brouillon ${TAG}`), []);
    assert.equal((await api("GET", `/public/events/${draft.slug}`)).status, 404);
    assert.equal((await api("POST", `/public/events/${draft.slug}/like`, { body: { deviceId: "appareil-brouillon" } })).status, 404);
    const order = await api("POST", "/orders", { body: { eventSlug: draft.slug, items: [{ categoryId: draft.categories[0].id, quantity: 1 }], buyer: { name: "Aïcha", phone: "+22997000000", provider: "mtn" } } });
    assert.ok([404, 409].includes(order.status));
  });
});

describe("Jetons : chaque type n'ouvre que ses propres routes", () => {
  test("jeton staff refusé côté organisateur, jeton organisateur refusé côté scanner, agent limité à son événement", async () => {
    const orga = await createOrganizer("cross-jetons");
    const evA = await createPublishedEvent(orga.token, { name: `Jetons A ${TAG}` });
    const evB = await createPublishedEvent(orga.token, { name: `Jetons B ${TAG}` });
    const { tickets } = await buyTickets(evB.slug, [{ categoryId: evB.categories[0].id, quantity: 1 }]);
    const staffA = await staffAccess(orga.token, evA.id);

    for (const [method, path] of [["GET", "/events"], ["GET", `/events/${evA.id}/stats`], ["GET", "/auth/me"], ["POST", "/uploads/cover"]]) {
      assert.equal((await api(method, path, { token: staffA.token })).status, 401, `${method} ${path} avec un jeton staff`);
    }
    assert.equal((await api("POST", "/scan", { token: orga.token, body: { qrPayload: "x", deviceId: "d" } })).status, 401);
    assert.equal((await api("GET", "/staff/tickets", { token: orga.token })).status, 401);

    // L'agent de A scanne un ticket de B : refusé, et le ticket de B reste valide
    const r = await api("POST", "/scan", { token: staffA.token, body: { qrPayload: tickets[0].qrPayload, deviceId: "porte-a" } });
    assert.equal(r.body.result, "INVALID");
    const staffB = await staffAccess(orga.token, evB.id);
    assert.equal((await api("POST", "/scan", { token: staffB.token, body: { qrPayload: tickets[0].qrPayload, deviceId: "porte-b" } })).body.result, "OK",
      "le ticket de B n'a pas été consommé par l'agent de A");
  });
});

describe("Finitions de l'API", () => {
  test("405 avec l'en-tête Allow pour une méthode non prévue, avant toute authentification", async () => {
    for (const [method, path, allow] of [["PUT", "/events", "GET, POST"], ["DELETE", "/orders/00000000-0000-0000-0000-000000000000", "GET"], ["GET", "/scan", "POST"]]) {
      const r = await api(method, path);
      assert.deepEqual([r.status, r.body.error.code, r.headers.get("allow")], [405, "METHOD_NOT_ALLOWED", allow], `${method} ${path}`);
    }
    assert.equal((await api("GET", "/nimporte/quoi")).status, 404, "route inconnue : toujours 404");
  });

  test("corps JSON de plus de 1 Mo → 413 lisible par le client (pas de coupure)", async () => {
    const r = await api("POST", "/orders", { body: { eventSlug: "x".repeat(1_100_000) } });
    assert.deepEqual([r.status, r.body.error.code], [413, "PAYLOAD_TOO_LARGE"]);
  });

  test("messages de validation en français, même sans message personnalisé", async () => {
    const cases = [
      [api("POST", "/orders", { body: { eventSlug: "a".repeat(100) } }), "eventSlug", "80 caractères maximum"],
      [api("POST", "/staff/login", { body: { code: 123456, pin: "1234" } }), "code", "Type invalide : un texte attendu"],
      [api("GET", "/public/events?limit=abc"), "limit", "Type invalide : un nombre attendu"],
    ];
    for (const [promise, field, message] of cases) {
      const r = await promise;
      assert.deepEqual([r.status, r.body.error.field, r.body.error.message], [400, field, message]);
    }
  });

  test("en-têtes communs : JSON, nosniff, format d'erreur uniforme", async () => {
    const r = await fetch(`${API}/public/events/nexiste-pas-x9z9`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-type"), /application\/json/);
    assert.deepEqual(Object.keys((await r.json()).error).sort(), ["code", "message"]);
  });
});
