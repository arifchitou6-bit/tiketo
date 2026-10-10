import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, buyTickets, cleanup, createEvent, createOrder, createOrganizer, createPublishedEvent, futureDates, setup, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Événements (CRUD organisateur)", () => {
  let marc, awa;
  before(async () => {
    marc = await createOrganizer("marc");
    awa = await createOrganizer("awa");
  });

  test("sans session → 401", async () => {
    assert.equal((await api("GET", "/events")).status, 401);
  });

  test("création : brouillon, slug sans accents, catégories, stats à zéro", async () => {
    const ev = await createEvent(marc.token, { name: "Afro Night — Cotonou 2026 !" });
    assert.equal(ev.status, "DRAFT");
    assert.match(ev.slug, /^afro-night-cotonou-2026-[a-z2-9]{4}$/);
    assert.equal(ev.categories.length, 2);
    assert.deepEqual(ev.stats, { capacity: 220, ticketsSold: 0, revenue: 0, fillRate: 0, scannedCount: 0 });
  });

  test("validation : dates inversées, prix négatif, noms en double ; brouillon sans catégorie accepté", async () => {
    const base = { name: "Test", venue: "X", city: "Y", ...futureDates() };
    let r = await api("POST", "/events", { token: marc.token, body: { ...base, startsAt: base.endsAt, endsAt: base.startsAt, categories: [{ name: "A", priceFcfa: 1, quantity: 1 }] } });
    assert.deepEqual([r.status, r.body.error.field], [400, "endsAt"]);
    r = await api("POST", "/events", { token: marc.token, body: { ...base, categories: [{ name: "A", priceFcfa: 1, quantity: 1 }, { name: "B", priceFcfa: -5, quantity: 1 }] } });
    assert.deepEqual([r.status, r.body.error.field], [400, "categories.1.priceFcfa"]);
    r = await api("POST", "/events", { token: marc.token, body: { ...base, categories: [] } });
    assert.equal(r.status, 201, "brouillon sans catégorie de tickets accepté (contrôle à la publication)");
    r = await api("POST", "/events", { token: marc.token, body: { ...base, categories: [{ name: "VIP", priceFcfa: 1, quantity: 1 }, { name: "vip", priceFcfa: 2, quantity: 1 }] } });
    assert.equal(r.status, 400);
  });

  test("PATCH : renommer, modifier, ajouter et supprimer des catégories ; slug inchangé", async () => {
    const ev = await createEvent(marc.token, { categories: [{ name: "A", priceFcfa: 1000, quantity: 10 }, { name: "B", priceFcfa: 2000, quantity: 10 }, { name: "C", priceFcfa: 3000, quantity: 10 }] });
    const [a, b] = ev.categories;
    const r = await api("PATCH", `/events/${ev.id}`, {
      token: marc.token,
      body: { name: "Nouveau nom", categories: [{ id: a.id, name: "A", priceFcfa: 1000, quantity: 10 }, { id: b.id, name: "B+", priceFcfa: 2500, quantity: 10 }, { name: "D", priceFcfa: 500, quantity: 5 }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.event.slug, ev.slug);
    assert.deepEqual(r.body.event.categories.map((c) => `${c.name}:${c.priceFcfa}`), ["A:1000", "B+:2500", "D:500"]);

    const city = await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { city: "Porto-Novo" } });
    assert.deepEqual([city.body.event.city, city.body.event.name, city.body.event.categories.length], ["Porto-Novo", "Nouveau nom", 3]);
    assert.equal((await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: {} })).status, 400);
    const unknown = await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { categories: [{ id: "00000000-0000-0000-0000-000000000000", name: "X", priceFcfa: 1, quantity: 1 }] } });
    assert.deepEqual([unknown.status, unknown.body.error.code], [422, "CATEGORY_NOT_FOUND"]);
  });

  test("isolation : un autre organisateur reçoit 404 (lecture, modification, suppression, liste)", async () => {
    const ev = await createEvent(marc.token);
    assert.equal((await api("GET", `/events/${ev.id}`, { token: awa.token })).status, 404);
    assert.equal((await api("PATCH", `/events/${ev.id}`, { token: awa.token, body: { name: "Piraté" } })).status, 404);
    assert.equal((await api("DELETE", `/events/${ev.id}`, { token: awa.token })).status, 404);
    assert.equal((await api("GET", "/events/pas-un-uuid", { token: marc.token })).status, 404);
    const list = await api("GET", "/events", { token: awa.token });
    assert.ok(!list.body.events.some((e) => e.id === ev.id));
  });

  test("règles avec ventes : quantité < vendus, catégorie avec commandes, suppression, événement clos", async () => {
    const ev = await createEvent(marc.token);
    await api("POST", `/events/${ev.id}/publish`, { token: marc.token });
    const [std, vip] = ev.categories;
    await buyTickets(ev.slug, [{ categoryId: std.id, quantity: 10 }]);

    const detail = await api("GET", `/events/${ev.id}`, { token: marc.token });
    assert.deepEqual([detail.body.event.stats.ticketsSold, detail.body.event.stats.revenue], [10, 50000]);

    let r = await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { categories: [{ id: std.id, name: "Standard", priceFcfa: 5000, quantity: 5 }, { id: vip.id, name: "VIP", priceFcfa: 15000, quantity: 20 }] } });
    assert.deepEqual([r.status, r.body.error.code], [409, "QUANTITY_BELOW_SOLD"]);
    r = await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { categories: [{ id: vip.id, name: "VIP", priceFcfa: 15000, quantity: 20 }] } });
    assert.deepEqual([r.status, r.body.error.code], [409, "CATEGORY_HAS_ORDERS"]);
    r = await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { categories: [{ id: std.id, name: "Standard", priceFcfa: 5000, quantity: 200 }] } });
    assert.equal(r.status, 200, "supprimer une catégorie sans vente est autorisé");
    r = await api("DELETE", `/events/${ev.id}`, { token: marc.token });
    assert.deepEqual([r.status, r.body.error.code], [409, "EVENT_HAS_SALES"]);

    await api("POST", `/events/${ev.id}/close`, { token: marc.token });
    r = await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { name: "Nouveau" } });
    assert.deepEqual([r.status, r.body.error.code], [409, "EVENT_CLOSED"]);
  });

  test("suppression : événement avec un panier abandonné → 204, tout est supprimé", async () => {
    const ev = await createEvent(marc.token);
    await api("POST", `/events/${ev.id}/publish`, { token: marc.token });
    await createOrder(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 2 }]);
    assert.equal((await api("DELETE", `/events/${ev.id}`, { token: marc.token })).status, 204);
    assert.equal((await api("GET", `/events/${ev.id}`, { token: marc.token })).status, 404);
    const [{ n }] = await sql("select count(*)::int as n from orders where event_id = $1", [ev.id]);
    assert.equal(n, 0);
  });

  test("publication et clôture", async () => {
    const ev = await createEvent(marc.token);
    assert.deepEqual((await api("POST", `/events/${ev.id}/close`, { token: marc.token })).body.error.code, "EVENT_NOT_PUBLISHED");
    assert.equal((await api("POST", `/events/${ev.id}/publish`, { token: awa.token })).status, 404);

    const pub = await api("POST", `/events/${ev.id}/publish`, { token: marc.token });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.event.status, "PUBLISHED");
    assert.ok(pub.body.publicUrl.endsWith(`/events/${ev.slug}`));
    assert.equal((await api("POST", `/events/${ev.id}/publish`, { token: marc.token })).status, 200, "idempotent");

    const closed = await api("POST", `/events/${ev.id}/close`, { token: marc.token });
    assert.equal(closed.body.event.status, "CLOSED");
    assert.equal((await api("POST", `/events/${ev.id}/close`, { token: marc.token })).status, 200, "idempotent");
    assert.equal((await api("POST", `/events/${ev.id}/publish`, { token: marc.token })).body.error.code, "EVENT_CLOSED");

    const past = await createEvent(marc.token);
    await sql("update events set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = $1", [past.id]);
    assert.equal((await api("POST", `/events/${past.id}/publish`, { token: marc.token })).body.error.code, "EVENT_ENDED");

    const empty = await createEvent(marc.token);
    await sql("delete from ticket_categories where event_id = $1", [empty.id]);
    assert.equal((await api("POST", `/events/${empty.id}/publish`, { token: marc.token })).body.error.code, "NO_CATEGORY");
  });

  test("liste : indicateurs par événement", async () => {
    const r = await api("GET", "/events", { token: marc.token });
    assert.equal(r.status, 200);
    for (const e of r.body.events) {
      for (const k of ["capacity", "ticketsSold", "revenue", "scannedCount"]) assert.equal(typeof e[k], "number");
    }
  });
});

describe("Sécurité : URL de l'image de couverture", () => {
  test("javascript: et data: refusés (XSS), https accepté", async () => {
    const orga = await createOrganizer("cover-url");
    for (const url of ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "ftp://exemple.bj/a.jpg"]) {
      const r = await api("POST", "/events", { token: orga.token, body: { name: "Test", venue: "X", city: "Y", ...futureDates(), coverImageUrl: url, categories: [{ name: "A", priceFcfa: 1, quantity: 1 }] } });
      assert.deepEqual([r.status, r.body.error.field], [400, "coverImageUrl"], url);
    }
    const ok = await createEvent(orga.token, { coverImageUrl: "https://images.example.com/cover.jpg" });
    assert.equal(ok.coverImageUrl, "https://images.example.com/cover.jpg");
    const patch = await api("PATCH", `/events/${ok.id}`, { token: orga.token, body: { coverImageUrl: "javascript:alert(1)" } });
    assert.equal(patch.status, 400, "refusé aussi en modification");
  });
});

describe("Sécurité : pas d'écriture directe en base (contournement de l'API)", () => {
  test("un organisateur ne peut pas modifier ses catégories via l'API REST de Supabase", async () => {
    const orga = await createOrganizer("direct-write");
    const ev = await createPublishedEvent(orga.token);
    await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 2 }]);
    const rest = (method, path, body) => fetch(`${process.env.SUPABASE_URL ?? "http://127.0.0.1:54321"}/rest/v1/${path}`, {
      method,
      headers: { apikey: process.env.SUPABASE_ANON_KEY ?? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH", Authorization: `Bearer ${orga.token}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    assert.equal((await rest("PATCH", `ticket_categories?id=eq.${ev.categories[0].id}`, { sold: 0 })).status, 403);
    assert.equal((await rest("DELETE", `events?id=eq.${ev.id}`)).status, 403);
    const [{ sold }] = await sql("select sold from ticket_categories where id = $1", [ev.categories[0].id]);
    assert.equal(sold, 2);
  });
});
