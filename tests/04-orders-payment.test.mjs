import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { api, BUYER, buyTickets, cleanup, createEvent, createOrder, createOrganizer, createPublishedEvent, setup, sql } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Commandes et paiement simulé", () => {
  let marc, ev, std, vip;
  before(async () => {
    marc = await createOrganizer("orders");
    ev = await createPublishedEvent(marc.token, { categories: [{ name: "Standard", priceFcfa: 5000, quantity: 200 }, { name: "VIP", priceFcfa: 15000, quantity: 3 }] });
    [std, vip] = ev.categories;
  });

  test("création : PENDING, total calculé par le serveur, téléphone normalisé, paymentUrl", async () => {
    const r = await api("POST", "/orders", {
      body: { eventSlug: ev.slug, items: [{ categoryId: std.id, quantity: 2 }, { categoryId: vip.id, quantity: 1 }], buyer: { ...BUYER, phone: "+229 97 00 00 00", email: "aicha@example.com" } },
    });
    assert.equal(r.status, 201);
    const o = r.body.order;
    assert.deepEqual([o.status, o.totalAmount, o.buyerPhone], ["PENDING", 25000, "+22997000000"]);
    assert.match(o.paymentReference, /^TKO-[A-Z2-9]{10}$/);
    assert.ok(r.body.paymentUrl.includes(`/events/${ev.slug}/checkout/pay?orderId=${o.id}`));
    const [{ sold }] = await sql("select sold from ticket_categories where id = $1", [std.id]);
    assert.equal(sold, 0, "une commande ne réserve pas de places");
  });

  test("validation et règles de commande", async () => {
    const order = (items, buyer = BUYER, slug = ev.slug) => api("POST", "/orders", { body: { eventSlug: slug, items, buyer } });
    let r = await order([{ categoryId: std.id, quantity: 1 }, { categoryId: std.id, quantity: 2 }]);
    assert.equal(r.body.order.items[0].quantity, 3, "même catégorie regroupée");
    r = await order([{ categoryId: vip.id, quantity: 5 }]);
    assert.deepEqual([r.status, r.body.error.code], [409, "SOLD_OUT"]);
    r = await order([{ categoryId: vip.id, quantity: 1, priceFcfa: 1 }]);
    assert.deepEqual([r.status, r.body.error.field], [400, "items.0.priceFcfa"]);
    assert.equal((await order([])).status, 400);
    assert.equal((await order([{ categoryId: std.id, quantity: 20 }, { categoryId: vip.id, quantity: 1 }])).status, 400);
    assert.equal((await order([{ categoryId: std.id, quantity: 1 }], { ...BUYER, provider: "orange" })).body.error.field, "buyer.provider");
    assert.equal((await order([{ categoryId: std.id, quantity: 1 }], { ...BUYER, phone: "abc123" })).body.error.field, "buyer.phone");
    assert.equal((await order([{ categoryId: std.id, quantity: 1 }], { ...BUYER, email: "" })).status, 201);
    assert.equal((await order([{ categoryId: std.id, quantity: 1 }], BUYER, "nexiste-pas-1234")).status, 404);

    const other = await createPublishedEvent(marc.token);
    assert.equal((await order([{ categoryId: other.categories[0].id, quantity: 1 }])).body.error.code, "CATEGORY_NOT_FOUND");
    const draft = await createEvent(marc.token);
    assert.equal((await order([{ categoryId: draft.categories[0].id, quantity: 1 }], BUYER, draft.slug)).status, 404);
    await api("POST", `/events/${other.id}/close`, { token: marc.token });
    assert.equal((await order([{ categoryId: other.categories[0].id, quantity: 1 }], BUYER, other.slug)).body.error.code, "EVENT_CLOSED");
  });

  test("paiement : tickets générés, QR signés HMAC, places attribuées, idempotent", async () => {
    const { order, tickets } = await buyTickets(ev.slug, [{ categoryId: std.id, quantity: 2 }]);
    assert.equal(order.status, "PAID");
    assert.equal(tickets.length, 2);

    const [{ qr_secret: secret }] = await sql("select qr_secret from event_secrets where event_id = $1", [ev.id]);
    for (const t of tickets) {
      const [prefix, id, sig] = t.qrPayload.split(".");
      assert.equal(prefix, "TCKT");
      assert.equal(id, t.id);
      assert.equal(sig, createHmac("sha256", secret).update(id).digest("base64url"), "signature HMAC");
    }
    const again = await api("POST", `/orders/${order.id}/simulate-payment`);
    assert.equal(again.status, 200);
    const [{ n }] = await sql("select count(*)::int as n from tickets where order_id = $1", [order.id]);
    assert.equal(n, 2, "pas de tickets en double");
  });

  test("paiements simultanés sur les dernières places : jamais de survente", async () => {
    const e = await createPublishedEvent(marc.token, { categories: [{ name: "Rare", priceFcfa: 1000, quantity: 2 }] });
    const c = e.categories[0].id;
    const a = await createOrder(e.slug, [{ categoryId: c, quantity: 2 }]);
    const b = await createOrder(e.slug, [{ categoryId: c, quantity: 2 }]);
    const results = await Promise.all([a, b].map((o) => api("POST", `/orders/${o.id}/simulate-payment`)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error.code, "SOLD_OUT");
    const [{ sold }] = await sql("select sold from ticket_categories where id = $1", [c]);
    assert.equal(sold, 2);
  });

  test("commande expirée et billetterie fermée après la commande", async () => {
    const o = await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]);
    await sql("update orders set created_at = now() - interval '16 minutes' where id = $1", [o.id]);
    const r = await api("POST", `/orders/${o.id}/simulate-payment`);
    assert.deepEqual([r.status, r.body.error.code], [409, "ORDER_EXPIRED"]);
    const [{ status }] = await sql("select status from orders where id = $1", [o.id]);
    assert.equal(status, "FAILED");

    const e = await createPublishedEvent(marc.token);
    const o2 = await createOrder(e.slug, [{ categoryId: e.categories[0].id, quantity: 1 }]);
    await api("POST", `/events/${e.id}/close`, { token: marc.token });
    assert.equal((await api("POST", `/orders/${o2.id}/simulate-payment`)).body.error.code, "EVENT_CLOSED");
    assert.equal((await api("POST", "/orders/00000000-0000-0000-0000-000000000000/simulate-payment")).status, 404);
  });

  test("détail de commande : tickets seulement si payée, expiration paresseuse", async () => {
    const pending = await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]);
    let r = await api("GET", `/orders/${pending.id}`);
    assert.deepEqual([r.status, r.body.order.status, r.body.tickets.length], [200, "PENDING", 0]);
    assert.equal(r.headers.get("cache-control"), "no-store");

    const { order } = await buyTickets(ev.slug, [{ categoryId: std.id, quantity: 1 }, { categoryId: vip.id, quantity: 1 }]);
    r = await api("GET", `/orders/${order.id}`);
    assert.deepEqual([r.body.order.status, r.body.tickets.length, r.body.order.event.slug], ["PAID", 2, ev.slug]);

    await sql("update orders set created_at = now() - interval '16 minutes' where id = $1", [pending.id]);
    r = await api("GET", `/orders/${pending.id}`);
    assert.deepEqual([r.body.order.status, r.body.order.failureReason], ["FAILED", "ORDER_EXPIRED"]);
    assert.equal((await api("GET", "/orders/abc")).status, 404);
  });

  test("tâche planifiée : expire_pending_orders() n'expire que les commandes en attente de plus de 15 min", async () => {
    const old = await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]);
    const recent = await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]);
    await sql("update orders set created_at = now() - interval '16 minutes' where id = $1", [old.id]);
    await sql("select public.expire_pending_orders(15)");
    const rows = await sql("select id, status from orders where id = any($1)", [[old.id, recent.id]]);
    assert.equal(rows.find((x) => x.id === old.id).status, "FAILED");
    assert.equal(rows.find((x) => x.id === recent.id).status, "PENDING");
    const jobs = await sql("select jobname from cron.job where jobname like 'ticketo-%' and active order by 1");
    assert.deepEqual(jobs.map((j) => j.jobname), ["ticketo-cleanup", "ticketo-demo-reset", "ticketo-expire-pending-orders"]);
  });
});
