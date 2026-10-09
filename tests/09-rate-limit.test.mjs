// Ce fichier sature volontairement les compteurs : il s'exécute en dernier (suite séquentielle).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { API, api, cleanup, createOrganizer, createPublishedEvent, resetRateLimits, setup, staffAccess, waitForFreshMinute } from "./helpers.mjs";

// Envoie n requêtes par paquets parallèles : en production, les 61 ou 101 requêtes doivent tenir dans
// la même minute malgré la latence ; en local, une à la fois (le PC de dev limite le CPU de l'API : 504)
const BATCH = /127\.0\.0\.1|localhost/.test(API) ? 1 : 20;
async function burst(n, send) {
  const statuses = [];
  for (let i = 0; i < n; i += BATCH) {
    statuses.push(...(await Promise.all(Array.from({ length: Math.min(BATCH, n - i) }, send))).map((r) => r.status));
  }
  return statuses;
}

before(async () => {
  await setup();
  // Commencer au début d'une fenêtre d'une minute pour que toutes les requêtes tombent dans la même
  await waitForFreshMinute(45);
});
after(async () => {
  await resetRateLimits();
  await cleanup();
});

describe("Limites de requêtes (rate limiting)", () => {
  test("connexion : 10 essais puis 429 avec Retry-After", async () => {
    const statuses = [];
    let last;
    for (let i = 0; i < 11; i++) {
      last = await api("POST", "/auth/login", { body: { email: "pirate@example.com", password: `essai${i}` } });
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
    assert.equal(last.body.error.code, "RATE_LIMITED");
    assert.ok(Number(last.headers.get("retry-after")) > 0);
  });

  test("un faux X-Forwarded-For ne contourne pas la limite", async () => {
    const r = await api("POST", "/auth/login", { body: { email: "pirate@example.com", password: "x" }, headers: { "X-Forwarded-For": "6.6.6.6" } });
    assert.equal(r.status, 429);
  });

  test("compteurs indépendants par route ; PIN staff limité à 10/min", async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await api("POST", "/staff/login", { body: { code: "ZZZZZZ", pin: String(1000 + i) } })).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429], "la limite /auth n'affecte pas /staff/login");
  });

  test("commandes : 60/min (IP partagées par les opérateurs mobiles)", async () => {
    // Début d'une fenêtre d'une minute, puis envoi par paquets parallèles : les 61 requêtes doivent
    // tenir dans la même minute, même avec une connexion lente (~1 s par requête)
    await waitForFreshMinute();
    const statuses = await burst(60, () => api("POST", "/orders", { body: {} }));
    statuses.push((await api("POST", "/orders", { body: {} })).status);
    assert.equal(statuses.filter((s) => s === 400).length, 60);
    assert.equal(statuses[60], 429);
  });
});

describe("Limite du scan comptée par agent (et non par IP)", () => {
  test("deux agents sur la même IP (wifi du club) : chacun a ses 100 scans/min", async () => {
    await resetRateLimits(); // le test précédent a saturé la limite /auth
    const orga = await createOrganizer("rl-scan");
    const ev = await createPublishedEvent(orga.token);
    const agentA = await staffAccess(orga.token, ev.id);
    const agentB = (await api("POST", "/staff/login", { body: { code: agentA.code, pin: agentA.pin } })).body.token;

    // Démarrer au début d'une fenêtre d'une minute
    await waitForFreshMinute();

    const scan = (token) => api("POST", "/scan", { token, body: { qrPayload: "QR-de-test", deviceId: "d" } });
    const statusesA = await burst(100, () => scan(agentA.token));
    statusesA.push((await scan(agentA.token)).status);
    assert.equal(statusesA.filter((s) => s === 200).length, 100);
    assert.equal(statusesA[100], 429, "le 101e scan de l'agent A est bloqué");
    assert.equal((await scan(agentB)).status, 200, "l'agent B, même IP, n'est pas bloqué");
  });
});
