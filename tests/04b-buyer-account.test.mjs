// PRD v2 : compte acheteur par code e-mail (OTP), commandes et favoris.
// Les e-mails de test sont en @example.com : l'API ne leur envoie jamais rien (domaine réservé).
// Le code n'étant stocké qu'en empreinte, les tests posent un code connu directement en base.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { api, buyTickets, cleanup, createOrganizer, createPublishedEvent, resetRateLimits, setup, sql, staffAccess } from "./helpers.mjs";

const RUN = Date.now().toString(36);
const emails = [];
const newEmail = (label) => {
  const e = `acheteur-${RUN}-${label}@example.com`;
  emails.push(e);
  return e;
};

before(async () => {
  await setup();
  await resetRateLimits();
});
after(async () => {
  await sql("delete from buyers where email = any($1)", [emails]);
  await sql("delete from buyer_otps where email = any($1)", [emails]);
  await cleanup();
});

const hash = (email, code) => createHash("sha256").update(`${email}:${code}`).digest("hex");
async function setCode(email, code, { expiresIn = "10 minutes" } = {}) {
  await sql(
    `insert into buyer_otps (email, code_hash, expires_at) values ($1, $2, now() + $3::interval)
     on conflict (email) do update set code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at`,
    [email, hash(email, code), expiresIn],
  );
}
// La vérification est limitée à 10 essais/min par IP : ce fichier en fait davantage
async function verify(email, code, extra = {}) {
  await resetRateLimits();
  return api("POST", "/buyer/otp/verify", { body: { email, code, ...extra } });
}
async function login(email, extra = {}) {
  await setCode(email, "424242");
  const r = await verify(email, "424242", extra);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.session.token, buyer: r.body.buyer };
}

describe("Compte acheteur : demande et vérification du code", () => {
  test("demande : réponse identique pour tout e-mail, délai de 60 s entre deux envois, e-mail invalide refusé", async () => {
    const email = newEmail("demande");
    const r = await api("POST", "/buyer/otp/request", { body: { email: email.toUpperCase() } });
    assert.deepEqual([r.status, r.body], [200, { sent: true, expiresInSeconds: 600, retryAfterSeconds: 60 }]);
    const [{ n }] = await sql("select count(*)::int n from buyer_otps where email = $1", [email]);
    assert.equal(n, 1, "e-mail normalisé en minuscules, code enregistré (empreinte)");

    const again = await api("POST", "/buyer/otp/request", { body: { email } });
    assert.deepEqual([again.status, again.body.error.code], [429, "OTP_COOLDOWN"]);
    assert.ok(Number(again.headers.get("retry-after")) > 0);

    const bad = await api("POST", "/buyer/otp/request", { body: { email: "pas-un-email" } });
    assert.deepEqual([bad.status, bad.body.error.field], [400, "email"]);
  });

  test("plafond de 5 codes par heure et par e-mail (protège la boîte et le quota d'envoi)", async () => {
    await resetRateLimits();
    const email = newEmail("plafond");
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api("POST", "/buyer/otp/request", { body: { email } })).status);
      await sql("update buyer_otps set created_at = now() - interval '2 minutes' where email = $1", [email]); // saute le délai de 60 s
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    await resetRateLimits();
  });

  test("vérification : essais restants, blocage après 5 erreurs, code expiré, code à usage unique", async () => {
    const email = newEmail("verif");
    await setCode(email, "123456");
    let r = await verify(email, "000000");
    assert.deepEqual([r.status, r.body.error.code, r.body.error.field], [401, "OTP_INVALID", "code"]);
    assert.match(r.body.error.message, /4 essais restants/);
    for (let i = 0; i < 4; i++) r = await verify(email, "000000");
    assert.deepEqual([r.status, r.body.error.code], [429, "OTP_TOO_MANY_ATTEMPTS"]);
    r = await verify(email, "123456");
    assert.equal(r.body.error.code, "OTP_TOO_MANY_ATTEMPTS", "même le bon code est refusé après 5 erreurs");

    await setCode(email, "123456", { expiresIn: "-1 minute" });
    assert.equal((await verify(email, "123456")).body.error.code, "OTP_EXPIRED");

    await setCode(email, "123456");
    r = await verify(email, "123456");
    assert.equal(r.status, 200);
    assert.match(r.body.session.token, /^[0-9a-f]{64}$/);
    assert.equal((await verify(email, "123456")).body.error.code, "OTP_INVALID", "un code ne sert qu'une fois");
    assert.equal((await verify(newEmail("inconnu"), "123456")).body.error.code, "OTP_INVALID", "aucun code demandé");
  });

  test("compte créé à la première connexion, retrouvé ensuite ; seules les empreintes sont stockées", async () => {
    const email = newEmail("compte");
    const first = await login(email);
    const second = await login(email);
    assert.equal(first.buyer.id, second.buyer.id);
    assert.deepEqual([first.buyer.email, first.buyer.name, first.buyer.phone], [email, null, null]);
    const rows = await sql("select token_hash from buyer_sessions where buyer_id = $1", [first.buyer.id]);
    assert.equal(rows.length, 2);
    assert.ok(!rows.some((x) => x.token_hash === first.token), "jeton stocké en empreinte uniquement");
  });

  test("compte de démonstration : code fixe, aucun code envoyé", async () => {
    const r = await api("POST", "/buyer/otp/request", { body: { email: "acheteur@ticketo.bj" } });
    assert.equal(r.body.demo, true);
    assert.equal((await verify("acheteur@ticketo.bj", "246810")).status, 200);
    assert.equal((await verify("acheteur@ticketo.bj", "111111")).body.error.code, "OTP_INVALID");
  });
});

describe("Compte acheteur : session, commandes et favoris", () => {
  let orga, ev1, ev2;
  before(async () => {
    await resetRateLimits();
    orga = await createOrganizer("acheteur");
    ev1 = await createPublishedEvent(orga.token, { name: `Soirée acheteur ${RUN}` });
    ev2 = await createPublishedEvent(orga.token, { name: `Concert acheteur ${RUN}`, category: "CONCERT" });
  });

  test("profil et déconnexion ; chaque jeton n'ouvre que son espace", async () => {
    const { token } = await login(newEmail("session"));
    assert.equal((await api("GET", "/buyer/me", { token })).status, 200);
    assert.equal((await api("GET", "/events", { token })).status, 401, "jeton acheteur refusé côté organisateur");
    assert.equal((await api("GET", "/buyer/me", { token: orga.token })).status, 401, "jeton organisateur refusé côté acheteur");
    const staff = await staffAccess(orga.token, ev1.id);
    assert.equal((await api("GET", "/buyer/orders", { token: staff.token })).status, 401, "jeton staff refusé côté acheteur");
    assert.equal((await api("GET", "/buyer/me")).status, 401);

    assert.equal((await api("POST", "/buyer/logout", { token })).status, 204);
    assert.equal((await api("GET", "/buyer/me", { token })).status, 401, "déconnexion immédiate");
  });

  test("commandes : celles passées avec l'e-mail avant le compte + celles passées connecté ; profil pré-rempli", async () => {
    const email = newEmail("commandes");
    const before = await buyTickets(ev1.slug, [{ categoryId: ev1.categories[0].id, quantity: 2 }],
      { name: "Aïcha K.", phone: "+22997000001", email, provider: "mtn" });
    const other = await buyTickets(ev1.slug, [{ categoryId: ev1.categories[0].id, quantity: 1 }],
      { name: "Autre", phone: "+22997000002", email: newEmail("autre"), provider: "mtn" });

    const { token, buyer } = await login(email);
    // Connecté, sans e-mail dans le formulaire : l'e-mail du compte est utilisé
    const r = await api("POST", "/orders", {
      token,
      body: { eventSlug: ev2.slug, items: [{ categoryId: ev2.categories[0].id, quantity: 1 }], buyer: { name: "Aïcha Kpèdé", phone: "+229 96 00 00 03", provider: "moov" } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.order.buyerEmail, email);
    const [{ buyer_id }] = await sql("select buyer_id from orders where id = $1", [r.body.order.id]);
    assert.equal(buyer_id, buyer.id);

    const me = (await api("GET", "/buyer/me", { token })).body.buyer;
    assert.deepEqual([me.name, me.phone], ["Aïcha Kpèdé", "+22996000003"], "dernier nom et numéro : pré-remplissage du formulaire");

    const list = (await api("GET", "/buyer/orders", { token })).body;
    assert.deepEqual(list.orders.map((o) => o.id), [r.body.order.id, before.order.id], "la plus récente d'abord");
    assert.ok(!list.orders.some((o) => o.id === other.order.id), "aucune commande d'un autre acheteur");
    const paid = list.orders[1];
    assert.deepEqual([paid.status, paid.ticketCount, paid.summary, paid.event.slug, paid.event.timeZone], ["PAID", 2, "2× Standard", ev1.slug, "Africa/Porto-Novo"]);

    const onlyPaid = (await api("GET", "/buyer/orders?status=PAID", { token })).body;
    assert.deepEqual([onlyPaid.pagination.total, onlyPaid.orders[0].id], [1, before.order.id]);
    const page2 = (await api("GET", "/buyer/orders?pageSize=1&page=2", { token })).body;
    assert.deepEqual([page2.orders.length, page2.pagination.totalPages], [1, 2]);
  });

  test("jeton acheteur invalide sur une route publique → 401 (le front reconnecte l'acheteur)", async () => {
    const r = await api("POST", "/orders", { token: "f".repeat(64), body: { eventSlug: ev1.slug } });
    assert.equal(r.status, 401);
  });

  test("favoris : likes de l'appareil rattachés à la connexion, likes connectés depuis un autre appareil, retrait", async () => {
    const email = newEmail("favoris");
    await api("POST", `/public/events/${ev1.slug}/like`, { body: { deviceId: "telephone-aicha-01" } }); // avant connexion
    const { token } = await login(email, { deviceId: "telephone-aicha-01" });
    await api("POST", `/public/events/${ev2.slug}/like`, { token, body: { deviceId: "ordinateur-aicha-02" } });

    let fav = (await api("GET", "/buyer/favorites", { token })).body.events;
    assert.deepEqual(new Set(fav.map((e) => e.id)), new Set([ev1.id, ev2.id]));
    assert.ok(fav.every((e) => e.isLiked && e.likesCount >= 1 && "minPriceFcfa" in e && "isSalesOpen" in e));

    // Retrait depuis un autre appareil que celui du like : le favori disparaît quand même
    const r = await api("DELETE", `/public/events/${ev1.slug}/like?deviceId=tablette-aicha-03`, { token });
    assert.equal(r.body.liked, false);
    fav = (await api("GET", "/buyer/favorites", { token })).body.events;
    assert.deepEqual(fav.map((e) => e.id), [ev2.id]);
    assert.equal((await api("GET", `/public/events/${ev1.slug}?deviceId=telephone-aicha-01`)).body.event.likesCount, 0);
  });
});
