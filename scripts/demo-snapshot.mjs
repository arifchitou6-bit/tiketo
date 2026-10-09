#!/usr/bin/env node
// TICKETO — photographie l'état actuel du compte de démo.
// C'est cet état que pg_cron restaure chaque nuit à 3 h (heure de Cotonou) : public.demo_reset().
// À relancer après le seed, ou après une modification voulue de la démo (nouvelle affiche, migration de schéma…).
//
// Usage :
//   npm run demo:snapshot                                                   (base locale)
//   node --env-file=.env.production.local scripts/demo-snapshot.mjs         (production : DATABASE_URL)

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@ticketo.bj";

const client = new pg.Client({ connectionString: DATABASE_URL });
try {
  await client.connect();
  const { rows } = await client.query("select public.demo_snapshot($1) as counts", [DEMO_EMAIL]);
  console.log(`✔ Photo de la démo enregistrée (${DEMO_EMAIL}) :`, rows[0].counts);
  console.log("  Remise à zéro automatique : chaque nuit à 3 h (heure de Cotonou)");
} catch (e) {
  console.error(`✘ Échec : ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
