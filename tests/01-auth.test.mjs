import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { api, cleanup, createOrganizer, resetRateLimits, setup } from "./helpers.mjs";

before(setup);
after(cleanup);
// Ce fichier fait plus de 10 appels /auth : compteurs remis à zéro entre les tests
beforeEach(resetRateLimits);

describe("Authentification organisateur", () => {
  let orga;
  before(async () => {
    orga = await createOrganizer("auth");
  });

  test("inscription : 201, email normalisé, session renvoyée", () => {
    assert.equal(orga.user.email, orga.email.toLowerCase());
    assert.ok(orga.token.length > 100);
    assert.ok(orga.refreshToken);
  });

  test("email déjà utilisé → 409 EMAIL_TAKEN", async () => {
    const r = await api("POST", "/auth/signup", { body: { email: orga.email.toUpperCase(), password: "motdepasse123", name: "Doublon" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "EMAIL_TAKEN");
    assert.equal(r.body.error.field, "email");
  });

  test("validation : email invalide, mot de passe court, champ inconnu, JSON cassé", async () => {
    let r = await api("POST", "/auth/signup", { body: { email: "pas-un-email", password: "motdepasse123", name: "X Y" } });
    assert.deepEqual([r.status, r.body.error.field], [400, "email"]);
    r = await api("POST", "/auth/signup", { body: { email: "a@example.com", password: "court", name: "X Y" } });
    assert.deepEqual([r.status, r.body.error.field], [400, "password"]);
    r = await api("POST", "/auth/signup", { body: { email: "a@example.com", password: "motdepasse123", name: "X Y", role: "admin" } });
    assert.deepEqual([r.status, r.body.error.field], [400, "role"]);
    r = await api("POST", "/auth/signup", { body: "{email:" });
    assert.equal(r.body.error.code, "INVALID_JSON");
  });

  test("connexion : mauvais mot de passe → 401, bon mot de passe → 200", async () => {
    let r = await api("POST", "/auth/login", { body: { email: orga.email, password: "mauvais" } });
    assert.deepEqual([r.status, r.body.error.code], [401, "INVALID_CREDENTIALS"]);
    r = await api("POST", "/auth/login", { body: { email: orga.email, password: orga.password } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, orga.user.id);
  });

  test("/me : sans jeton, faux jeton, jeton modifié → 401 ; jeton valide → 200", async () => {
    assert.equal((await api("GET", "/auth/me")).status, 401);
    assert.equal((await api("GET", "/auth/me", { token: "faux.jeton.xyz" })).status, 401);
    const [h, p, s] = orga.token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    claims.sub = "00000000-0000-0000-0000-000000000000";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    assert.equal((await api("GET", "/auth/me", { token: forged })).status, 401);
    const r = await api("GET", "/auth/me", { token: orga.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, "Test auth");
  });

  test("refresh puis déconnexion : la session est révoquée immédiatement", async () => {
    const login = await api("POST", "/auth/login", { body: { email: orga.email, password: orga.password } });
    const { accessToken, refreshToken } = login.body.session;
    const refreshed = await api("POST", "/auth/refresh", { body: { refreshToken } });
    assert.equal(refreshed.status, 200);
    const token = refreshed.body.session.accessToken;

    assert.equal((await api("POST", "/auth/logout", { token })).status, 204);
    assert.equal((await api("GET", "/auth/me", { token })).status, 401);
    assert.equal((await api("GET", "/events", { token })).status, 401);
    assert.equal((await api("POST", "/auth/refresh", { body: { refreshToken: refreshed.body.session.refreshToken } })).status, 401);
    assert.ok(accessToken);
  });
});
