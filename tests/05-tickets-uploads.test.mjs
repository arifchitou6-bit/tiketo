import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { API, api, buyTickets, cleanup, createOrganizer, createPublishedEvent, setup } from "./helpers.mjs";

before(setup);
after(cleanup);

describe("Image QR des tickets", () => {
  let tickets;
  before(async () => {
    const marc = await createOrganizer("qr");
    const ev = await createPublishedEvent(marc.token, { name: "Afro Night Cotonou", categories: [{ name: "VIP Carré", priceFcfa: 15000, quantity: 20 }] });
    ({ tickets } = await buyTickets(ev.slug, [{ categoryId: ev.categories[0].id, quantity: 2 }]));
  });

  test("PNG lisible par un décodeur QR indépendant, contenu identique au ticket", async () => {
    for (const t of tickets) {
      const res = await fetch(t.qrUrl.replace(/^.*\/functions\/v1\/api/, API));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.match(res.headers.get("cache-control"), /immutable/);
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      assert.ok(decoded, "QR illisible");
      assert.equal(decoded.data, t.qrPayload);
    }
  });

  test("?download=1 → pièce jointe avec un nom de fichier propre ; ticket inconnu → 404", async () => {
    const res = await fetch(`${API}/tickets/${tickets[0].id}/qr.png?download=1`);
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="ticket-afro-night-cotonou-vip-carre-[0-9a-f]{8}\.png"$/);
    assert.equal((await api("GET", "/tickets/00000000-0000-0000-0000-000000000000/qr.png")).status, 404);
  });
});

describe("Upload de l'image de couverture", () => {
  let token;
  before(async () => {
    token = (await createOrganizer("upload")).token;
  });

  const upload = async (file, auth = true) => {
    const form = new FormData();
    if (file) form.append("file", file);
    const res = await fetch(`${API}/uploads/cover`, { method: "POST", headers: auth ? { Authorization: `Bearer ${token}` } : {}, body: form });
    return { status: res.status, body: await res.json() };
  };
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(1)]);

  test("contrôles : authentification, fichier absent, faux type, taille", async () => {
    assert.equal((await upload(new Blob([PNG_BYTES]), false)).status, 401);
    assert.equal((await upload(null)).body.error.field, "file");
    assert.equal((await upload(new File(["ceci est un texte"], "faux.jpg", { type: "image/jpeg" }))).status, 415);
    assert.equal((await upload(new File([new Uint8Array(6_000_000)], "gros.png", { type: "image/png" }))).status, 413);
  });

  // Nécessite le service Storage (indisponible sur la machine de dev locale) : TEST_STORAGE=1 npm test
  test("enregistrement réel dans Storage", { skip: process.env.TEST_STORAGE !== "1" }, async () => {
    const r = await upload(new File([PNG_BYTES], "cover.png", { type: "image/png" }));
    assert.equal(r.status, 201);
    assert.match(r.body.url, /\/storage\/v1\/object\/public\/event-covers\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    assert.equal((await fetch(r.body.url)).status, 200);
  });
});
