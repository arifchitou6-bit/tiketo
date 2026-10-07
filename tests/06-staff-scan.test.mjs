import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { api, buyTickets, cleanup, createEvent, createOrganizer, createPublishedEvent, setup, staffAccess, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

describe("Code staff et connexion de l'agent de porte", () => {
  let marc, awa;
  before(async () => {
    marc = await createOrganizer("staff");
    awa = await createOrganizer("staff-awa");
  });

  test("génération : 6 caractères + PIN 4 chiffres, PIN haché, réservé au propriétaire", async () => {
    const ev = await createEvent(marc.token);
    assert.equal((await api("POST", `/events/${ev.id}/staff-code`)).status, 401);
    assert.equal((await api("POST", `/events/${ev.id}/staff-code`, { token: awa.token })).status, 404);
    const r = await api("POST", `/events/${ev.id}/staff-code`, { token: marc.token });
    assert.equal(r.status, 201);
    assert.match(r.body.code, /^[A-Z2-9]{6}$/);
    assert.match(r.body.pin, /^\d{4}$/);
    const [{ staff_pin_hash: hash }] = await sql("select staff_pin_hash from event_secrets where event_id = $1", [ev.id]);
    assert.match(hash, /^\$2[aby]\$/, "PIN haché en bcrypt");
    const login = await api("POST", "/staff/login", { body: { code: r.body.code, pin: r.body.pin } });
    assert.equal(login.body.error.code, "EVENT_NOT_PUBLISHED");
  });

  test("connexion : erreurs, index hors ligne, jeton non stocké, régénération qui déconnecte", async () => {
    const ev = await createPublishedEvent(marc.token);
    const { tickets } = await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 3 }]);
    const { body: { code, pin } } = await api("POST", `/events/${ev.id}/staff-code`, { token: marc.token });

    const wrong = await api("POST", "/staff/login", { body: { code, pin: pin === "0000" ? "1111" : "0000" } });
    const unknown = await api("POST", "/staff/login", { body: { code: "ZZZZZZ", pin } });
    assert.deepEqual([wrong.status, unknown.status], [401, 401]);
    assert.equal(wrong.body.error.message, unknown.body.error.message, "même message : ne révèle pas si le code existe");
    assert.equal((await api("POST", "/staff/login", { body: { code, pin: "123" } })).status, 400);

    const login = await api("POST", "/staff/login", { body: { code: code.toLowerCase(), pin, deviceId: "android-kevin" } });
    assert.equal(login.status, 200);
    assert.equal(login.body.token.length, 64);
    assert.deepEqual(new Set(login.body.ticketHashes), new Set(tickets.map((t) => sha256(t.qrPayload))));
    assert.deepEqual(Object.keys(login.body.tickets[0]).sort(), ["category", "hash", "holderName", "scannedAt", "status"]);
    const [{ n }] = await sql("select count(*)::int as n from staff_sessions where token_hash = $1", [login.body.token]);
    assert.equal(n, 0, "le jeton brut n'est jamais stocké");

    const kevin = login.body.token;
    assert.equal((await api("GET", "/staff/tickets", { token: kevin })).body.totalTickets, 3);
    assert.equal((await api("GET", "/events", { token: kevin })).status, 401, "jeton staff refusé sur les routes organisateur");

    await api("POST", `/events/${ev.id}/staff-code`, { token: marc.token });
    assert.equal((await api("GET", "/staff/tickets", { token: kevin })).status, 401, "ancienne session révoquée");
    assert.equal((await api("POST", "/staff/login", { body: { code, pin } })).status, 401, "ancien code invalide");
  });
});

describe("Scan en ligne", () => {
  let marc, A, B, kevin, lucie;
  before(async () => {
    marc = await createOrganizer("scan");
    const evA = await createPublishedEvent(marc.token);
    const evB = await createPublishedEvent(marc.token);
    A = { ev: evA, tickets: (await buyTickets(evA.slug, [{ categoryId: evA.categories[0].id, quantity: 3 }, { categoryId: evA.categories[1].id, quantity: 1 }])).tickets };
    B = { ev: evB, tickets: (await buyTickets(evB.slug, [{ categoryId: evB.categories[0].id, quantity: 1 }])).tickets };
    const access = await staffAccess(marc.token, evA.id);
    kevin = access.token;
    lucie = (await api("POST", "/staff/login", { body: { code: access.code, pin: access.pin } })).body.token;
  });

  const scan = (token, qrPayload, extra = {}) => api("POST", "/scan", { token, body: { qrPayload, deviceId: "android-kevin", ...extra } });

  test("OK puis DUPLICATE avec l'heure du premier passage", async () => {
    assert.equal((await scan(null, A.tickets[0].qrPayload)).status, 401);
    const ok = await scan(kevin, A.tickets[0].qrPayload);
    assert.deepEqual([ok.body.result, ok.body.holderName, ok.body.category, ok.body.scannedCount], ["OK", "Aïcha K.", "Standard", 1]);
    const dup = await scan(kevin, A.tickets[0].qrPayload);
    assert.equal(dup.body.result, "DUPLICATE");
    assert.equal(dup.body.previousScanAt, ok.body.scannedAt);
    assert.equal(dup.body.scannedCount, 1);
  });

  test("INVALID : signature modifiée, signature volée, autre événement, QR quelconque", async () => {
    const [, id] = A.tickets[1].qrPayload.split(".");
    const stolenSig = A.tickets[0].qrPayload.split(".")[2];
    for (const qr of [A.tickets[1].qrPayload.replace(/.{4}$/, "AAAA"), `TCKT.${id}.${stolenSig}`, B.tickets[0].qrPayload, "https://resto.bj/menu", "TCKT.00000000-0000-0000-0000-000000000000.abc"]) {
      assert.equal((await scan(kevin, qr)).body.result, "INVALID", qr);
    }
    const [{ status }] = await sql("select status from tickets where id = $1", [B.tickets[0].id]);
    assert.equal(status, "VALID", "le ticket de l'autre événement n'est pas consommé");
    const [{ n }] = await sql("select count(*)::int as n from scan_events where event_id = $1", [B.ev.id]);
    assert.equal(n, 0);
    assert.equal((await api("POST", "/scan", { token: kevin, body: { qrPayload: "x" } })).body.error.field, "deviceId");
  });

  test("deux agents scannent le même ticket au même instant : un seul OK", async () => {
    const qr = A.tickets[2].qrPayload;
    const results = await Promise.all([scan(kevin, qr, { deviceId: "android-kevin" }), scan(lucie, qr, { deviceId: "iphone-lucie" })]);
    assert.deepEqual(results.map((r) => r.body.result).sort(), ["DUPLICATE", "OK"]);
  });

  test("heure dans le futur ramenée à l'heure serveur ; journal complet", async () => {
    const r = await scan(kevin, A.tickets[3].qrPayload, { scannedAt: "2030-01-01T00:00:00Z" });
    assert.equal(r.body.result, "OK");
    assert.ok(new Date(r.body.scannedAt).getTime() <= Date.now() + 5000);
    const rows = await sql("select result, count(*)::int as n from scan_events where event_id = $1 group by 1 order by 1", [A.ev.id]);
    assert.deepEqual(Object.fromEntries(rows.map((x) => [x.result, x.n])), { OK: 3, DUPLICATE: 2, INVALID: 5 });
  });
});

describe("Réessai d'un scan dont la réponse s'est perdue", () => {
  test("même clientScanId → résultat d'origine (OK) avec replayed, pas « déjà scanné »", async () => {
    const orga = await createOrganizer("retry");
    const ev = await createPublishedEvent(orga.token);
    const { tickets } = await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 1 }]);
    const { token } = await staffAccess(orga.token, ev.id);
    const body = { qrPayload: tickets[0].qrPayload, deviceId: "android-kevin", clientScanId: "scan-42" };

    const first = await api("POST", "/scan", { token, body });
    const retry = await api("POST", "/scan", { token, body });
    assert.equal(first.body.result, "OK");
    assert.deepEqual([retry.body.result, retry.body.replayed, retry.body.holderName], ["OK", true, "Aïcha K."]);
    assert.equal(retry.body.scannedCount, 1);

    const rescan = await api("POST", "/scan", { token, body: { ...body, clientScanId: "scan-43" } });
    assert.equal(rescan.body.result, "DUPLICATE", "un nouveau scan (autre identifiant) reste un doublon");
  });
});
