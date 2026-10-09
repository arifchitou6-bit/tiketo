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

  test("valeurs par défaut quand le front ne les envoie pas (compatibilité)", async () => {
    const ev = await createEvent(orga.token);
    assert.deepEqual([ev.category, ev.country, ev.timeZone, ev.coverFit, ev.likesCount], ["SOIREE", "BJ", "Africa/Porto-Novo", "cover", 0]);
    assert.equal(ev.categories[0].description, "");
  });

  test("création, modification et page publique avec tous les champs", async () => {
    const ev = await createPublishedEvent(orga.token, {
      category: "CONCERT", country: "tg", timeZone: "Africa/Lome", coverFit: "contain",
      categories: [{ name: "Fosse", priceFcfa: 5000, quantity: 100, description: "Debout, devant la scène" }],
    });
    assert.deepEqual([ev.category, ev.country, ev.timeZone, ev.coverFit], ["CONCERT", "TG", "Africa/Lome", "contain"]);

    const patched = await api("PATCH", `/events/${ev.id}`, {
      token: orga.token,
      body: { category: "FESTIVAL", categories: [{ id: ev.categories[0].id, name: "Fosse", priceFcfa: 5000, quantity: 100, description: "Accès fosse" }] },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.event.category, "FESTIVAL");
    assert.equal(patched.body.event.country, "TG", "champ non envoyé : inchangé");
    assert.equal(patched.body.event.categories[0].description, "Accès fosse");

    const pub = (await api("GET", `/public/events/${ev.slug}`)).body.event;
    assert.deepEqual([pub.category, pub.country, pub.timeZone, pub.coverFit, pub.likesCount], ["FESTIVAL", "TG", "Africa/Lome", "contain", 0]);
    assert.equal(pub.categories[0].description, "Accès fosse");

    const list = (await api("GET", "/events", { token: orga.token })).body.events.find((e) => e.id === ev.id);
    assert.deepEqual([list.category, list.country, list.timeZone, list.coverFit, list.likesCount], ["FESTIVAL", "TG", "Africa/Lome", "contain", 0]);
  });

  test("valeurs invalides refusées avec le champ en cause", async () => {
    const cases = [
      [{ category: "KARAOKE" }, "category"],
      [{ country: "BEN" }, "country"],
      [{ timeZone: "Mars/Olympus" }, "timeZone"],
      [{ coverFit: "stretch" }, "coverFit"],
      [{ categories: [{ name: "A", priceFcfa: 1, quantity: 1, description: "x".repeat(301) }] }, "categories.0.description"],
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
