import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, buyTickets, cleanup, createOrganizer, createPublishedEvent, setup, staffAccess, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Synchronisation des scans hors ligne", () => {
  let marc, ev, T, kevin, lucie;
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const s = (t, deviceId, min, clientScanId) => ({ qrPayload: t.qrPayload, deviceId, scannedAt: ago(min), clientScanId });
  const sync = (token, scans) => api("POST", "/scan/batch", { token, body: { scans } });

  before(async () => {
    marc = await createOrganizer("batch");
    ev = await createPublishedEvent(marc.token);
    T = (await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 8 }])).tickets;
    const access = await staffAccess(marc.token, ev.id);
    kevin = access.token;
    lucie = (await api("POST", "/staff/login", { body: { code: access.code, pin: access.pin } })).body.token;
  });

  const lot = () => [s(T[0], "android-kevin", 10, "k-1"), s(T[1], "android-kevin", 9, "k-2"), s(T[2], "android-kevin", 8, "k-3")];

  test("scénario du PRD : 3 scans hors ligne synchronisés et visibles par l'organisateur", async () => {
    const r = await sync(kevin, lot());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.summary, { total: 3, ok: 3, duplicate: 0, invalid: 0, error: 0, alreadySynced: 0 });
    assert.deepEqual(r.body.results.map((x) => [x.index, x.clientScanId, x.result]), [[0, "k-1", "OK"], [1, "k-2", "OK"], [2, "k-3", "OK"]]);
    assert.equal(r.body.scannedCount, 3);
    const rows = await sql("select scanned_at, synced_at from scan_events where event_id = $1 and client_scan_id like 'k-%'", [ev.id]);
    assert.ok(rows.every((x) => x.synced_at && x.scanned_at < x.synced_at), "heure réelle du scan + heure de réception");
    const stats = await api("GET", `/events/${ev.id}/stats`, { token: marc.token });
    assert.equal(stats.body.stats.scannedCount, 3);
  });

  test("renvoi du même lot : rien n'est compté deux fois", async () => {
    const r = await sync(kevin, lot());
    assert.deepEqual([r.body.summary.alreadySynced, r.body.summary.ok, r.body.scannedCount], [3, 0, 3]);
    const [{ n }] = await sql("select count(*)::int as n from scan_events where event_id = $1 and client_scan_id like 'k-%'", [ev.id]);
    assert.equal(n, 3);
  });

  test("conflit entre appareils : DUPLICATE signalé dans conflicts", async () => {
    const r = await sync(lucie, [s(T[0], "iphone-lucie", 7, "l-1"), s(T[3], "iphone-lucie", 6, "l-2")]);
    assert.deepEqual(r.body.results.map((x) => x.result), ["DUPLICATE", "OK"]);
    assert.deepEqual(r.body.conflicts, [0]);
  });

  test("lot dans le désordre : traité dans l'ordre chronologique", async () => {
    const r = await sync(kevin, [s(T[4], "android-kevin", 2, "k-5b"), s(T[4], "android-kevin", 5, "k-5a")]);
    assert.deepEqual(r.body.results.map((x) => [x.clientScanId, x.result]), [["k-5b", "DUPLICATE"], ["k-5a", "OK"]]);
  });

  test("lot mixte : chaque scan traité indépendamment", async () => {
    const r = await sync(kevin, [
      s(T[5], "android-kevin", 1, "k-6"),
      { ...s(T[6], "android-kevin", 1, "k-7"), qrPayload: T[6].qrPayload.replace(/.{4}$/, "AAAA") },
      { qrPayload: "https://resto.bj/menu", deviceId: "android-kevin", scannedAt: ago(1), clientScanId: "k-8" },
    ]);
    assert.deepEqual(r.body.results.map((x) => x.result), ["OK", "INVALID", "INVALID"]);
  });

  test("validation : clientScanId requis, lot vide, plus de 500 scans, sans jeton", async () => {
    assert.equal((await sync(kevin, [{ qrPayload: T[7].qrPayload, deviceId: "d", scannedAt: ago(1) }])).body.error.field, "scans.0.clientScanId");
    assert.equal((await sync(kevin, [])).status, 400);
    assert.equal((await sync(kevin, Array.from({ length: 501 }, (_, i) => ({ qrPayload: "x", deviceId: "d", scannedAt: ago(1), clientScanId: `z${i}` })))).status, 400);
    assert.equal((await sync(null, lot())).status, 401);
  });

  test("performance : 500 scans en un lot", async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ qrPayload: "TCKT.00000000-0000-0000-0000-000000000000.x", deviceId: "perf", scannedAt: ago(1), clientScanId: `perf-${i}` }));
    const t0 = Date.now();
    const r = await sync(kevin, big);
    assert.equal(r.body.summary.total, 500);
    assert.ok(Date.now() - t0 < 15000, `trop lent : ${Date.now() - t0} ms`);
  });
});
