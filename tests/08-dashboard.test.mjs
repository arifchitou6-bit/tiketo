import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { api, buyTickets, cleanup, createOrder, createOrganizer, createPublishedEvent, setup, sql, staffAccess } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Statistiques du dashboard", () => {
  let marc, awa, ev;
  before(async () => {
    marc = await createOrganizer("stats");
    awa = await createOrganizer("stats-awa");
    ev = await createPublishedEvent(marc.token, { categories: [{ name: "Standard", priceFcfa: 5000, quantity: 100 }, { name: "VIP", priceFcfa: 15000, quantity: 20 }] });
    const [std, vip] = ev.categories;
    const a = await buyTickets(ev.slug, [{ categoryId: std.id, quantity: 3 }, { categoryId: vip.id, quantity: 1 }]);
    await buyTickets(ev.slug, [{ categoryId: vip.id, quantity: 2 }]);
    // Hausse du prix VIP après des ventes : la recette doit garder le prix payé
    await api("PATCH", `/events/${ev.id}`, { token: marc.token, body: { categories: [{ id: std.id, name: "Standard", priceFcfa: 5000, quantity: 100 }, { id: vip.id, name: "VIP", priceFcfa: 20000, quantity: 20 }] } });
    await buyTickets(ev.slug, [{ categoryId: vip.id, quantity: 1 }]);
    await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]);
    const failed = await createOrder(ev.slug, [{ categoryId: std.id, quantity: 1 }]);
    await sql("update orders set status = 'FAILED', failure_reason = 'ORDER_EXPIRED' where id = $1", [failed.id]);
    const { token } = await staffAccess(marc.token, ev.id);
    for (const qr of [a.tickets[0].qrPayload, a.tickets[3].qrPayload, a.tickets[0].qrPayload, "n'importe quoi"]) {
      await api("POST", "/scan", { token, body: { qrPayload: qr, deviceId: "k" } });
    }
  });

  test("chiffres exacts (calculés à la main)", async () => {
    const r = await api("GET", `/events/${ev.id}/stats`, { token: marc.token });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const s = r.body.stats;
    assert.deepEqual(
      [s.ticketsSold, s.capacity, s.revenue, s.fillRate, s.scannedCount],
      [7, 120, 80000, 5.8, 2],
    );
    assert.deepEqual(s.orders, { paid: 3, pending: 1, failed: 1 });
    assert.deepEqual(
      s.byCategory.map((c) => [c.name, c.sold, c.remaining, c.revenue, c.scanned]),
      [["Standard", 3, 97, 15000, 1], ["VIP", 4, 16, 65000, 1]],
    );
    assert.equal(s.salesOverTime.reduce((n, b) => n + b.tickets, 0), 7);
    assert.equal(s.scansOverTime.reduce((n, b) => n + b.count, 0), 2);
  });

  test("accès : autre organisateur → 404, sans session → 401", async () => {
    assert.equal((await api("GET", `/events/${ev.id}/stats`, { token: awa.token })).status, 404);
    assert.equal((await api("GET", `/events/${ev.id}/stats`)).status, 401);
  });

  test("polling : 10 appels successifs rapides", async () => {
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      assert.equal((await api("GET", `/events/${ev.id}/stats`, { token: marc.token })).status, 200);
      assert.ok(Date.now() - t0 < 5000, `appel ${i} trop lent : ${Date.now() - t0} ms`);
    }
  });
});

describe("Liste des commandes et export CSV", () => {
  let marc, awa, ev;
  before(async () => {
    marc = await createOrganizer("list");
    awa = await createOrganizer("list-awa");
    ev = await createPublishedEvent(marc.token, { name: "Afro Night Cotonou" });
    const [std, vip] = ev.categories;
    const names = ["Aïcha Kpèdétin", "Koffi Agbèssi", '=HYPERLINK("http://pirate.bj","Cliquez ici")', "Rodrigue d'Almeida", "Fèmi Hounkpè"];
    for (let i = 0; i < 25; i++) {
      const items = i % 3 === 0 ? [{ categoryId: std.id, quantity: 2 }, { categoryId: vip.id, quantity: 1 }] : [{ categoryId: std.id, quantity: 1 }];
      const buyer = { name: names[i % 5] + (i >= 5 ? ` ${i}` : ""), phone: `+2299700${String(i).padStart(4, "0")}`, provider: ["mtn", "moov", "celtiis"][i % 3] };
      if (i < 22) await buyTickets(ev.slug, items, buyer);
      else await createOrder(ev.slug, items, buyer);
    }
  });

  const list = (qs, token = marc.token) => api("GET", `/events/${ev.id}/orders${qs}`, { token });

  test("pagination, tri, filtre, page au-delà de la fin", async () => {
    const p1 = await list("?page=1&pageSize=10");
    assert.deepEqual(p1.body.pagination, { page: 1, pageSize: 10, total: 25, totalPages: 3 });
    const dates = p1.body.orders.map((o) => o.createdAt);
    assert.ok(dates.every((d, i) => i === 0 || dates[i - 1] >= d), "du plus récent au plus ancien");
    assert.match(p1.body.orders.find((o) => o.ticketCount === 3).summary, /^2× Standard, 1× VIP$/);
    assert.equal((await list("?page=3&pageSize=10")).body.orders.length, 5);
    const beyond = await list("?page=99&pageSize=10");
    assert.deepEqual([beyond.status, beyond.body.orders.length, beyond.body.pagination.total], [200, 0, 25]);
    const pending = await list("?status=PENDING");
    assert.equal(pending.body.orders.length, 3);
    assert.ok(pending.body.orders.every((o) => o.status === "PENDING"));
    assert.equal((await list("")).body.pagination.pageSize, 20);
    assert.equal((await list("?pageSize=500")).status, 400);
    assert.equal((await list("?status=REMBOURSE")).status, 400);
    assert.equal((await list("", awa.token)).status, 404);
  });

  test("export CSV : BOM, commandes payées uniquement, accents, formule neutralisée", async () => {
    const res = await fetch(`${process.env.API_URL ?? "http://127.0.0.1:54321/functions/v1/api"}/events/${ev.id}/orders/export.csv`, { headers: { Authorization: `Bearer ${marc.token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /filename="acheteurs-afro-night-cotonou\.csv"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8");
    const lines = buf.toString("utf8").replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines.length - 1, 22, "22 commandes payées");
    assert.ok(lines.some((l) => l.includes('"Aïcha Kpèdétin"')));
    const trap = lines.find((l) => l.includes("HYPERLINK"));
    assert.ok(trap.split(";")[1].startsWith(`"'=`), "formule neutralisée");
    assert.equal((await api("GET", `/events/${ev.id}/orders/export.csv`, { token: awa.token })).status, 404);
  });
});
