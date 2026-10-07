import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, cleanup, createEvent, createOrganizer, createPublishedEvent, setup, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Page publique d'un événement", () => {
  let marc;
  before(async () => {
    marc = await createOrganizer("public");
  });

  test("brouillon, slug inconnu ou malveillant → 404", async () => {
    const draft = await createEvent(marc.token);
    assert.equal((await api("GET", `/public/events/${draft.slug}`)).status, 404);
    assert.equal((await api("GET", "/public/events/nexiste-pas-x9z9")).status, 404);
    // En production, le pare-feu de Supabase (Cloudflare) bloque déjà ce motif d'injection SQL (403)
    assert.ok([403, 404].includes((await api("GET", "/public/events/abc'%20or%201=1--")).status));
  });

  test("événement publié : quotas restants, indicateurs, aucune donnée sensible, cache 30 s", async () => {
    const ev = await createPublishedEvent(marc.token, {
      categories: [{ name: "Early Bird", priceFcfa: 3000, quantity: 50 }, { name: "Standard", priceFcfa: 5000, quantity: 200 }, { name: "VIP", priceFcfa: 15000, quantity: 20 }],
    });
    await sql("update ticket_categories set sold = quantity where event_id = $1 and name = 'Early Bird'", [ev.id]);
    await sql("update ticket_categories set sold = 12 where event_id = $1 and name = 'Standard'", [ev.id]);

    const r = await api("GET", `/public/events/${ev.slug}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /max-age=30/);
    const e = r.body.event;
    assert.deepEqual(e.categories.map((c) => [c.name, c.remaining, c.isSoldOut]), [["Early Bird", 0, true], ["Standard", 188, false], ["VIP", 20, false]]);
    assert.deepEqual([e.isSalesOpen, e.isSoldOut, e.isPast], [true, false, false]);
    assert.equal(e.minPriceFcfa, 5000, "prix « à partir de » = moins chère catégorie encore disponible");

    const raw = JSON.stringify(r.body);
    for (const k of ["staffCode", "organizerId", "organizer_id", "sold", "quantity", "revenue", "qr_secret"]) {
      assert.ok(!raw.includes(`"${k}"`), `champ sensible exposé : ${k}`);
    }
    const again = await api("GET", `/public/events/${ev.slug.toUpperCase()}`);
    assert.equal(again.status, 200);
    // Cache mémoire par instance : HIT en local ; en production la requête peut arriver sur une autre instance
    assert.ok(["HIT", "MISS"].includes(again.headers.get("x-cache")));
    assert.deepEqual(again.body, r.body, "même contenu");
  });

  test("complet, terminé, clos : visibles mais ventes fermées", async () => {
    const soldOut = await createPublishedEvent(marc.token, { categories: [{ name: "Unique", priceFcfa: 10000, quantity: 30 }] });
    await sql("update ticket_categories set sold = quantity where event_id = $1", [soldOut.id]);
    let e = (await api("GET", `/public/events/${soldOut.slug}`)).body.event;
    assert.deepEqual([e.isSoldOut, e.isSalesOpen], [true, false]);

    const past = await createPublishedEvent(marc.token);
    await sql("update events set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = $1", [past.id]);
    e = (await api("GET", `/public/events/${past.slug}`)).body.event;
    assert.deepEqual([e.isPast, e.isSalesOpen], [true, false]);

    const closed = await createPublishedEvent(marc.token);
    await api("POST", `/events/${closed.id}/close`, { token: marc.token });
    e = (await api("GET", `/public/events/${closed.slug}`)).body.event;
    assert.deepEqual([e.status, e.isSalesOpen], ["CLOSED", false]);
  });
});
