// PRD v2 : catégorie d'événement, pays, fuseau horaire, cadrage de l'affiche, description des catégories de tickets
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, cleanup, createEvent, createOrganizer, createPublishedEvent, setup, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Champs PRD v2 des événements", () => {
  let orga;
  before(async () => {
    orga = await createOrganizer("v2");
  });

  test("brouillon avec le nom seul : valeurs par défaut, aucune catégorie de tickets", async () => {
    const r = await api("POST", "/events", { token: orga.token, body: { name: "Idée de soirée" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ev = r.body.event;
    assert.deepEqual([ev.status, ev.category, ev.venue, ev.city, ev.startsAt, ev.endsAt], ["DRAFT", null, null, null, null, null]);
    assert.deepEqual([ev.country, ev.timeZone, ev.coverFit, ev.likesCount, ev.categories], ["BJ", "Africa/Porto-Novo", "cover", 0, []]);
    const listed = (await api("GET", "/events", { token: orga.token })).body.events.find((e) => e.id === ev.id);
    assert.equal(listed.name, "Idée de soirée", "le brouillon apparaît dans le dashboard");
  });

  test("publication : chaque champ manquant est signalé, catégorie comprise", async () => {
    const ev = (await api("POST", "/events", { token: orga.token, body: { name: "À compléter" } })).body.event;
    const publish = () => api("POST", `/events/${ev.id}/publish`, { token: orga.token });
    const patch = (body) => api("PATCH", `/events/${ev.id}`, { token: orga.token, body });
    const steps = [
      ["category", { category: "CONCERT" }],
      ["venue", { venue: "Palais des Congrès" }],
      ["city", { city: "Cotonou" }],
      ["startsAt", { startsAt: "2030-01-01T19:00:00Z" }],
      ["endsAt", { endsAt: "2030-01-01T23:00:00Z" }],
      ["categories", { categories: [{ name: "Standard", priceFcfa: 5000, quantity: 100, description: "Placement libre" }] }],
    ];
    for (const [field, fix] of steps) {
      const r = await publish();
      assert.deepEqual([r.status, r.body.error.field], [field === "categories" ? 422 : 400, field], `champ attendu : ${field}`);
      assert.match(r.body.error.message, /avant de publier/);
      assert.equal((await patch(fix)).status, 200);
    }
    const ok = await publish();
    assert.deepEqual([ok.status, ok.body.event.status], [200, "PUBLISHED"]);
    const empty = await patch({ categories: [] });
    assert.deepEqual([empty.status, empty.body.error.field], [400, "categories"], "un événement publié garde au moins une catégorie");
  });

  test("pays BJ ou CI ; fuseau déduit du pays ; création, modification et page publique avec tous les champs", async () => {
    const ev = await createPublishedEvent(orga.token, {
      category: "CONCERT", country: "ci", coverFit: "contain",
      categories: [{ name: "Fosse", priceFcfa: 5000, quantity: 100, description: "Debout, devant la scène" }],
    });
    assert.deepEqual([ev.category, ev.country, ev.timeZone, ev.coverFit], ["CONCERT", "CI", "Africa/Abidjan", "contain"]);

    const patched = await api("PATCH", `/events/${ev.id}`, {
      token: orga.token,
      body: { category: "FESTIVAL", categories: [{ id: ev.categories[0].id, name: "Fosse", priceFcfa: 5000, quantity: 100, description: "Accès fosse" }] },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.event.category, "FESTIVAL");
    assert.equal(patched.body.event.country, "CI", "champ non envoyé : inchangé");
    assert.equal(patched.body.event.categories[0].description, "Accès fosse");

    const pub = (await api("GET", `/public/events/${ev.slug}`)).body.event;
    assert.deepEqual([pub.category, pub.country, pub.timeZone, pub.coverFit, pub.likesCount], ["FESTIVAL", "CI", "Africa/Abidjan", "contain", 0]);
    assert.equal(pub.categories[0].description, "Accès fosse");

    const back = await api("PATCH", `/events/${ev.id}`, { token: orga.token, body: { country: "BJ" } });
    assert.deepEqual([back.body.event.country, back.body.event.timeZone], ["BJ", "Africa/Porto-Novo"], "changer de pays change le fuseau");
  });

  test("valeurs invalides refusées avec le champ en cause", async () => {
    const cases = [
      [{ category: "KARAOKE" }, "category"],
      [{ country: "BEN" }, "country"],
      [{ country: "TG" }, "country"],
      [{ timeZone: "Mars/Olympus" }, "timeZone"],
      [{ coverFit: "stretch" }, "coverFit"],
      [{ categories: [{ name: "A", priceFcfa: 1, quantity: 1, description: "x".repeat(81) }] }, "categories.0.description"],
    ];
    for (const [overrides, field] of cases) {
      const r = await api("POST", "/events", {
        token: orga.token,
        body: { name: "Soirée", venue: "V", city: "C", startsAt: "2030-01-01T20:00:00Z", endsAt: "2030-01-02T02:00:00Z",
          categories: [{ name: "Standard", priceFcfa: 5000, quantity: 10 }], ...overrides },
      });
      assert.equal(r.status, 400, JSON.stringify(overrides));
      assert.equal(r.body.error.field, field);
    }
  });

  test("un like ne modifie pas la date de dernière modification ; le compteur suit les likes", async () => {
    const ev = await createPublishedEvent(orga.token);
    const [before] = await sql("select updated_at from events where id = $1", [ev.id]);
    await sql("insert into event_likes (event_id, device_id) values ($1, 'appareil-test-1'), ($1, 'appareil-test-2')", [ev.id]);
    await sql("delete from event_likes where event_id = $1 and device_id = 'appareil-test-1'", [ev.id]);
    const [row] = await sql("select likes_count, updated_at from events where id = $1", [ev.id]);
    assert.equal(row.likes_count, 1);
    assert.equal(row.updated_at.getTime(), before.updated_at.getTime());
  });
});
