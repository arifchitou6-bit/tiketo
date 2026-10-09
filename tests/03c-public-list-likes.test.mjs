// PRD v2 : liste et recherche publique (filtres, tri, pagination par curseur) et likes par appareil
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, cleanup, createEvent, createOrganizer, createPublishedEvent, resetRateLimits, setup, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

const DAY = 24 * 3600 * 1000;
const at = (days) => ({
  startsAt: new Date(Date.now() + days * DAY).toISOString(),
  endsAt: new Date(Date.now() + days * DAY + 6 * 3600 * 1000).toISOString(),
});
// Mot unique par exécution : isole ces tests des autres événements de la base (démo comprise)
const TAG = `zx${Date.now().toString(36)}`;
const list = (params) => api("GET", `/public/events?${new URLSearchParams(params)}`);

describe("Liste et recherche publique", () => {
  let orga;
  const ev = {};
  before(async () => {
    orga = await createOrganizer("liste");
    ev.concert = await createPublishedEvent(orga.token, {
      name: `Concert Élégance ${TAG}`, category: "CONCERT", city: "Porto-Novo", ...at(10),
      categories: [{ name: "Unique", priceFcfa: 8000, quantity: 10 }, { name: "VIP", priceFcfa: 20000, quantity: 5 }],
    });
    ev.soiree = await createPublishedEvent(orga.token, { name: `Soirée ${TAG}`, category: "SOIREE", ...at(5) });
    ev.lome = await createPublishedEvent(orga.token, { name: `Festival ${TAG}`, category: "FESTIVAL", country: "TG", city: "Lomé", ...at(20) });
    ev.draft = await createEvent(orga.token, { name: `Brouillon ${TAG}`, ...at(3) });
    ev.closed = await createPublishedEvent(orga.token, { name: `Clos ${TAG}`, ...at(4) });
    await api("POST", `/events/${ev.closed.id}/close`, { token: orga.token });
    ev.past = await createPublishedEvent(orga.token, { name: `Passé ${TAG}`, ...at(2) });
    await sql("update events set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = $1", [ev.past.id]);
    await sql("update ticket_categories set sold = quantity where event_id = $1 and name = 'Unique'", [ev.concert.id]);
  });

  test("seuls les événements publiés et non terminés, triés par date ; champs de carte", async () => {
    const r = await list({ q: TAG });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /public, max-age=30/);
    assert.deepEqual(r.body.events.map((e) => e.id), [ev.soiree.id, ev.concert.id, ev.lome.id]);
    assert.equal(r.body.nextCursor, null);

    const card = r.body.events[1];
    assert.equal(card.minPriceFcfa, 20000, "prix « à partir de » = moins chère catégorie encore disponible");
    assert.deepEqual([card.isSoldOut, card.isSalesOpen, card.likesCount, card.category], [false, true, 0, "CONCERT"]);
    assert.ok(!("isLiked" in card), "isLiked seulement avec deviceId");
    const raw = JSON.stringify(r.body);
    for (const k of ["staffCode", "organizerId", "sold", "quantity", "description"]) assert.ok(!raw.includes(`"${k}"`), `champ exposé : ${k}`);
  });

  test("recherche insensible aux accents et à la casse, tous les mots requis, sur le nom, le lieu et la ville", async () => {
    assert.deepEqual((await list({ q: `elegance ${TAG.toUpperCase()}` })).body.events.map((e) => e.id), [ev.concert.id]);
    assert.deepEqual((await list({ q: `${TAG} lome` })).body.events.map((e) => e.id), [ev.lome.id]);
    assert.deepEqual((await list({ q: `${TAG} introuvable` })).body.events, []);
    // La description n'est pas cherchée (PRD v2.1 §8.1)
    await api("PATCH", `/events/${ev.soiree.id}`, { token: orga.token, body: { description: "motcachedansladescription" } });
    assert.deepEqual((await list({ q: `${TAG} motcachedansladescription` })).body.events, []);
  });

  test("20 événements par page par défaut", async () => {
    const r = await list({});
    assert.ok(r.body.events.length <= 20);
  });

  test("popular : à likes égaux, le plus vendu d'abord, puis le plus proche", async () => {
    const t2 = `pp${Date.now().toString(36)}`; // mot-clé distinct : ces événements ne doivent pas apparaître dans les autres tests
    const tot = await createPublishedEvent(orga.token, { name: `Tôt ${t2}`, ...at(6) });
    const vendu = await createPublishedEvent(orga.token, { name: `Vendu ${t2}`, ...at(8) });
    const tard = await createPublishedEvent(orga.token, { name: `Tard ${t2}`, ...at(9) });
    await sql("update ticket_categories set sold = 7 where event_id = $1 and position = 0", [vendu.id]);
    const r = await list({ q: t2, sort: "popular", limit: 2 });
    assert.deepEqual(r.body.events.map((e) => e.id), [vendu.id, tot.id]);
    const p2 = await list({ q: t2, sort: "popular", limit: 2, cursor: r.body.nextCursor });
    assert.deepEqual(p2.body.events.map((e) => e.id), [tard.id], "pagination cohérente avec le second critère");
  });

  test("filtres catégorie et pays ; paramètres vides ignorés", async () => {
    assert.deepEqual((await list({ q: TAG, category: "FESTIVAL" })).body.events.map((e) => e.id), [ev.lome.id]);
    assert.deepEqual((await list({ q: TAG, country: "bj" })).body.events.map((e) => e.id), [ev.soiree.id, ev.concert.id]);
    assert.equal((await list({ q: TAG, category: "", country: "", cursor: "", sort: "" })).body.events.length, 3);
    for (const [params, field] of [[{ category: "KARAOKE" }, "category"], [{ sort: "prix" }, "sort"], [{ limit: "500" }, "limit"],
      [{ country: "BEN" }, "country"], [{ country: "TG" }, "country"], [{ cursor: "nimporte-quoi" }, "cursor"]]) {
      const r = await list(params);
      assert.equal(r.status, 400, JSON.stringify(params));
      assert.equal(r.body.error.field, field);
    }
  });

  test("pagination par curseur : pages complètes, sans doublon ni oubli", async () => {
    const p1 = await list({ q: TAG, limit: 2 });
    assert.deepEqual(p1.body.events.map((e) => e.id), [ev.soiree.id, ev.concert.id]);
    assert.ok(p1.body.nextCursor);
    const p2 = await list({ q: TAG, limit: 2, cursor: p1.body.nextCursor });
    assert.deepEqual(p2.body.events.map((e) => e.id), [ev.lome.id]);
    assert.equal(p2.body.nextCursor, null);

    const wrongSort = await list({ q: TAG, limit: 2, sort: "popular", cursor: p1.body.nextCursor });
    assert.equal(wrongSort.body.error.code, "INVALID_CURSOR", "curseur obtenu avec un autre tri");
  });

  test("likes : un par appareil, idempotents, compteur et isLiked ; tri popular paginé", async () => {
    await resetRateLimits();
    const like = (slug, deviceId) => api("POST", `/public/events/${slug}/like`, { body: { deviceId } });

    let r = await like(ev.lome.slug, "appareil-A-0001");
    assert.deepEqual([r.status, r.body], [200, { liked: true, likesCount: 1 }]);
    r = await like(ev.lome.slug, "appareil-A-0001");
    assert.equal(r.body.likesCount, 1, "liker deux fois depuis le même appareil ne compte qu'une fois");
    await like(ev.lome.slug, "appareil-B-0002");
    await like(ev.concert.slug, "appareil-A-0001");

    const pop1 = await list({ q: TAG, sort: "popular", limit: 2 });
    assert.deepEqual(pop1.body.events.map((e) => [e.id, e.likesCount]), [[ev.lome.id, 2], [ev.concert.id, 1]]);
    const pop2 = await list({ q: TAG, sort: "popular", limit: 2, cursor: pop1.body.nextCursor });
    assert.deepEqual(pop2.body.events.map((e) => e.id), [ev.soiree.id]);

    const mine = await list({ q: TAG, deviceId: "appareil-B-0002" });
    assert.equal(mine.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(mine.body.events.map((e) => e.isLiked), [false, false, true]);

    const detail = await api("GET", `/public/events/${ev.lome.slug}?deviceId=appareil-B-0002`);
    assert.deepEqual([detail.body.event.isLiked, detail.body.event.likesCount], [true, 2]);
    assert.ok(!("isLiked" in (await api("GET", `/public/events/${ev.lome.slug}`)).body.event));

    // DELETE : deviceId en paramètre (clients qui n'envoient pas de corps) ou dans le corps
    r = await api("DELETE", `/public/events/${ev.lome.slug}/like?deviceId=appareil-B-0002`);
    assert.deepEqual(r.body, { liked: false, likesCount: 1 });
    r = await api("DELETE", `/public/events/${ev.lome.slug}/like`, { body: { deviceId: "appareil-B-0002" } });
    assert.deepEqual(r.body, { liked: false, likesCount: 1 }, "idempotent");
  });

  test("GET /public/likes : slugs aimés par l'appareil", async () => {
    await resetRateLimits();
    await api("POST", `/public/events/${ev.soiree.slug}/like`, { body: { deviceId: "appareil-L-0009" } });
    await api("POST", `/public/events/${ev.concert.slug}/like`, { body: { deviceId: "appareil-L-0009" } });
    const r = await api("GET", "/public/likes?deviceId=appareil-L-0009");
    assert.equal(r.status, 200);
    assert.deepEqual(new Set(r.body.slugs), new Set([ev.soiree.slug, ev.concert.slug]));
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.deepEqual((await api("GET", "/public/likes?deviceId=appareil-vide-0001")).body, { slugs: [] });
    assert.equal((await api("GET", "/public/likes")).status, 400);
    for (const slug of [ev.soiree.slug, ev.concert.slug]) await api("DELETE", `/public/events/${slug}/like?deviceId=appareil-L-0009`);
  });

  test("likes refusés : brouillon ou inconnu (404), deviceId invalide (400)", async () => {
    assert.equal((await api("POST", `/public/events/${ev.draft.slug}/like`, { body: { deviceId: "appareil-C-0003" } })).status, 404);
    assert.equal((await api("POST", "/public/events/nexiste-pas-x9z9/like", { body: { deviceId: "appareil-C-0003" } })).status, 404);
    const bad = await api("POST", `/public/events/${ev.soiree.slug}/like`, { body: { deviceId: "<script>" } });
    assert.deepEqual([bad.status, bad.body.error.field], [400, "deviceId"]);
    assert.equal((await api("POST", `/public/events/${ev.soiree.slug}/like`, { body: {} })).status, 400);
  });

  test("supprimer un événement supprime ses likes", async () => {
    const tmp = await createPublishedEvent(orga.token, { name: `Temporaire ${TAG}` });
    await api("POST", `/public/events/${tmp.slug}/like`, { body: { deviceId: "appareil-D-0004" } });
    assert.equal((await api("DELETE", `/events/${tmp.id}`, { token: orga.token })).status, 204);
    assert.equal((await sql("select count(*)::int n from event_likes where event_id = $1", [tmp.id]))[0].n, 0);
  });
});
