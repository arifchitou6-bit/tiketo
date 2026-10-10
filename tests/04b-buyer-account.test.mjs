// PRD v2.1 §8.4 : compte acheteur par numéro de téléphone et code (devCode en démo), commandes et favoris.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, buyTickets, cleanup, createOrganizer, createPublishedEvent, resetRateLimits, setup, sql, staffAccess } from "./helpers.mjs";

// Numéros fictifs uniques à chaque exécution, au format béninois à 10 chiffres (+229 01XXXXXXXX)
const SEED = String(Date.now()).slice(-6);
const phones = [];
let n = 0;
const newPhone = () => {
  const p = `+22901${SEED}${String(n++).padStart(2, "0")}`;
  phones.push(p);
  return p;
};

before(async () => {
  await setup();
  await resetRateLimits();
});
after(async () => {
  await sql("delete from buyers where phone = any($1)", [phones]);
  await sql("delete from buyer_otps where phone = any($1)", [phones]);
  await cleanup();
});

// Les limites (5 demandes et 10 vérifications par minute et par IP) sont dépassées par ce fichier
async function request(phone) {
  await resetRateLimits();
  return api("POST", "/buyer/otp/request", { body: { phone } });
}
async function verify(phone, code, extra = {}) {
  await resetRateLimits();
  return api("POST", "/buyer/otp/verify", { body: { phone, code, ...extra } });
}
async function login(phone, extra = {}) {
  const { devCode } = (await request(phone)).body;
  const r = await verify(phone, devCode, extra);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body.session, buyer: r.body.buyer };
}

describe("Compte acheteur : demande et vérification du code", () => {
  test("demande : devCode à 6 chiffres, numéro normalisé, 60 s entre deux codes, numéro invalide refusé", async () => {
    const phone = newPhone();
    const r = await request(`${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6)}`); // avec espaces
    assert.equal(r.status, 200);
    assert.match(r.body.devCode, /^\d{6}$/);
    assert.deepEqual([r.body.expiresInSeconds, r.body.retryAfterSeconds], [600, 60]);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const [{ code_hash }] = await sql("select code_hash from buyer_otps where phone = $1", [phone]);
    assert.ok(code_hash.length === 64 && code_hash !== r.body.devCode, "code stocké en empreinte uniquement");

    const again = await request(phone);
    assert.deepEqual([again.status, again.body.error.code, again.body.error.field], [429, "RATE_LIMITED", "phone"]);
    assert.ok(Number(again.headers.get("retry-after")) > 0);

    const bad = await request("0197");
    assert.deepEqual([bad.status, bad.body.error.field], [400, "phone"]);
  });

  test("plafond de 5 codes par heure et par numéro", async () => {
    await resetRateLimits();
    const phone = newPhone();
    const results = [];
    for (let i = 0; i < 6; i++) {
      await sql("delete from rate_limits where key not like 'buyer-otp-phone:%'"); // garde seulement le compteur par numéro
      const r = await api("POST", "/buyer/otp/request", { body: { phone } });
      results.push([r.status, r.body.error?.code]);
      await sql("update buyer_otps set created_at = now() - interval '2 minutes' where phone = $1", [phone]); // saute les 60 s
    }
    assert.deepEqual(results, [...Array(5).fill([200, undefined]), [429, "RATE_LIMITED"]]);
  });

  test("vérification : essais restants, OTP_EXPIRED après 5 erreurs ou au-delà de 10 min, code à usage unique", async () => {
    const phone = newPhone();
    const { devCode } = (await request(phone)).body;
    const wrong = devCode === "000000" ? "111111" : "000000";
    let r = await verify(phone, wrong);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.field], [401, "OTP_INVALID", "code"]);
    assert.match(r.body.error.message, /4 essais restants/);
    for (let i = 0; i < 4; i++) r = await verify(phone, wrong);
    assert.deepEqual([r.status, r.body.error.code], [401, "OTP_EXPIRED"]);
    assert.equal((await verify(phone, devCode)).body.error.code, "OTP_EXPIRED", "même le bon code est refusé après 5 erreurs");

    await sql("update buyer_otps set created_at = now() - interval '2 minutes' where phone = $1", [phone]);
    const fresh = (await request(phone)).body.devCode;
    await sql("update buyer_otps set expires_at = now() - interval '1 second' where phone = $1", [phone]);
    assert.equal((await verify(phone, fresh)).body.error.code, "OTP_EXPIRED");

    await sql("delete from buyer_otps where phone = $1", [phone]);
    const last = (await request(phone)).body.devCode;
    r = await verify(phone, last);
    assert.equal(r.status, 200);
    assert.equal((await verify(phone, last)).body.error.code, "OTP_INVALID", "un code ne sert qu'une fois");
  });

  test("session au format organisateur, renouvelable par /auth/refresh (rotation) ; compte retrouvé ensuite", async () => {
    const phone = newPhone();
    const s = await login(phone);
    assert.deepEqual(Object.keys(s.buyer).sort(), ["createdAt", "id", "name", "phone"]);
    assert.deepEqual([s.buyer.phone, s.buyer.name], [phone, null]);
    assert.deepEqual([s.tokenType, s.expiresIn], ["bearer", 3600]);
    assert.match(s.accessToken, /^[0-9a-f]{64}$/);
    assert.match(s.refreshToken, /^[0-9a-f]{64}$/);

    await resetRateLimits();
    const r = await api("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } });
    assert.equal(r.status, 200);
    const renewed = r.body.session;
    assert.notEqual(renewed.accessToken, s.accessToken);
    assert.equal((await api("GET", "/buyer/me", { token: renewed.accessToken })).status, 200);
    assert.equal((await api("GET", "/buyer/me", { token: s.accessToken })).status, 401, "l'ancien jeton d'accès ne marche plus");
    assert.equal((await api("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } })).body.error.code,
      "INVALID_REFRESH_TOKEN", "un jeton de renouvellement ne sert qu'une fois");

    // Jeton d'accès expiré → 401, le front renouvelle
    await sql("update buyer_sessions set expires_at = now() - interval '1 second' where buyer_id = $1", [s.buyer.id]);
    assert.equal((await api("GET", "/buyer/me", { token: renewed.accessToken })).status, 401);

    const again = await login(phone);
    assert.equal(again.buyer.id, s.buyer.id, "même compte à la connexion suivante");
  });

  test("devCode désactivable (BUYER_OTP_DEV_CODE=off) : documenté, activé par défaut en démo", async () => {
    const r = await request(newPhone());
    assert.ok("devCode" in r.body);
  });
});

describe("Compte acheteur : session, commandes et favoris", () => {
  let orga, ev1, ev2;
  before(async () => {
    await resetRateLimits();
    orga = await createOrganizer("acheteur");
    ev1 = await createPublishedEvent(orga.token, { name: `Soirée acheteur ${SEED}` });
    ev2 = await createPublishedEvent(orga.token, { name: `Concert acheteur ${SEED}`, category: "CONCERT" });
  });

  test("profil et déconnexion ; chaque jeton n'ouvre que son espace", async () => {
    const { accessToken: token } = await login(newPhone());
    assert.equal((await api("GET", "/buyer/me", { token })).status, 200);
    assert.equal((await api("GET", "/events", { token })).status, 401, "jeton acheteur refusé côté organisateur");
    assert.equal((await api("GET", "/buyer/me", { token: orga.token })).status, 401, "jeton organisateur refusé côté acheteur");
    const staff = await staffAccess(orga.token, ev1.id);
    assert.equal((await api("GET", "/buyer/orders", { token: staff.token })).status, 401, "jeton staff refusé côté acheteur");
    assert.equal((await api("GET", "/buyer/me")).status, 401);

    assert.equal((await api("POST", "/buyer/logout", { token })).status, 204);
    assert.equal((await api("GET", "/buyer/me", { token })).status, 401, "déconnexion immédiate");
  });

  test("commandes payées avec ce numéro, sur n'importe quel appareil, au format de GET /orders/:id ; nom repris", async () => {
    const phone = newPhone();
    const paid = await buyTickets(ev1.slug, [{ categoryId: ev1.categories[0].id, quantity: 2 }], { name: "Aïcha K.", phone, provider: "mtn" });
    const paid2 = await buyTickets(ev2.slug, [{ categoryId: ev2.categories[0].id, quantity: 1 }],
      { name: "Aïcha Kpèdé", phone: `${phone.slice(0, 4)} ${phone.slice(4)}`, provider: "moov" }); // même numéro, autre saisie
    await api("POST", "/orders", { body: { eventSlug: ev1.slug, items: [{ categoryId: ev1.categories[0].id, quantity: 1 }], buyer: { name: "Aïcha", phone, provider: "mtn" } } }); // non payée
    await buyTickets(ev1.slug, [{ categoryId: ev1.categories[0].id, quantity: 1 }], { name: "Autre", phone: newPhone(), provider: "mtn" });

    const s = await login(phone);
    assert.equal(s.buyer.name, "Aïcha Kpèdé", "nom de la dernière commande payée");
    const { orders } = (await api("GET", "/buyer/orders", { token: s.accessToken })).body;
    assert.deepEqual(orders.map((o) => o.order.id), [paid2.order.id, paid.order.id], "payées seulement, la plus récente d'abord");
    const same = (await api("GET", `/orders/${paid.order.id}`)).body;
    assert.deepEqual(orders[1], { order: same.order, tickets: same.tickets }, "même format que GET /orders/:id");
    assert.equal(orders[1].tickets.length, 2);
  });

  test("favoris : likes de l'appareil rattachés à la connexion, likes connectés depuis un autre appareil, retrait", async () => {
    await api("POST", `/public/events/${ev1.slug}/like`, { body: { deviceId: "telephone-aicha-01" } }); // avant connexion
    const { accessToken: token } = await login(newPhone(), { deviceId: "telephone-aicha-01" });
    await api("POST", `/public/events/${ev2.slug}/like`, { token, body: { deviceId: "ordinateur-aicha-02" } });

    let fav = (await api("GET", "/buyer/favorites", { token })).body.events;
    assert.deepEqual(new Set(fav.map((e) => e.slug)), new Set([ev1.slug, ev2.slug]));
    assert.ok(fav.every((e) => e.isLiked && e.likesCount >= 1 && "minPriceFcfa" in e && "coverFit" in e));

    // Cœurs pleins sur un nouvel appareil : GET /public/likes avec le jeton inclut les likes du compte
    const slugs = (await api("GET", "/public/likes?deviceId=tablette-aicha-03", { token })).body.slugs;
    assert.deepEqual(new Set(slugs), new Set([ev1.slug, ev2.slug]));

    // Retrait depuis un autre appareil que celui du like : le favori disparaît quand même
    const r = await api("DELETE", `/public/events/${ev1.slug}/like?deviceId=tablette-aicha-03`, { token });
    assert.equal(r.body.liked, false);
    fav = (await api("GET", "/buyer/favorites", { token })).body.events;
    assert.deepEqual(fav.map((e) => e.slug), [ev2.slug]);
  });

  test("jeton acheteur invalide sur un like → 401 (le front renouvelle ou reconnecte)", async () => {
    const r = await api("POST", `/public/events/${ev1.slug}/like`, { token: "f".repeat(64), body: { deviceId: "appareil-x-0001" } });
    assert.equal(r.status, 401);
  });
});
