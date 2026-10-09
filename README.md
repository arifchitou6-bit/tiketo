# TICKETO — Backend

**Billetterie événementielle pour le Bénin et l'Afrique francophone** : création d'événements, vente de tickets sécurisés par QR code signé, paiement Mobile Money (simulé), contrôle d'accès à l'entrée — même sans réseau.

Ce dépôt contient le **backend complet**, déployé sur **Supabase** : base Postgres, authentification, stockage et API REST (Edge Function).

> Projet portfolio de l'agence **WANE** — Back-end : Arif · Front-end : Jude

## 🌍 En ligne

| | |
|---|---|
| **API (production)** | `https://yedvgoroseersrjyyfol.supabase.co/functions/v1/api` |
| Vérification | [`/health`](https://yedvgoroseersrjyyfol.supabase.co/functions/v1/api/health) |
| Documentation | [docs/API.md](docs/API.md) |

**Comptes de démonstration (production)**

| Rôle | Accès |
|---|---|
| Organisateur | `demo@ticketo.bj` / `Demo-rL8LuShU-2026` |
| Agent de porte — Afro Night Cotonou | code `X3RSGG` · PIN `4097` |
| Agent de porte — Jazz sous les étoiles | code `93395Z` · PIN `1315` |
| Page publique (API) | [`/public/events/afro-night-cotonou-3hhi`](https://yedvgoroseersrjyyfol.supabase.co/functions/v1/api/public/events/afro-night-cotonou-3hhi) · [`/public/events/jazz-sous-les-etoiles-u8u5`](https://yedvgoroseersrjyyfol.supabase.co/functions/v1/api/public/events/jazz-sous-les-etoiles-u8u5) |
| Commande payée (écran de succès) | [`/orders/490879ed-0632-4f4f-963c-28c971e025c9`](https://yedvgoroseersrjyyfol.supabase.co/functions/v1/api/orders/490879ed-0632-4f4f-963c-28c971e025c9) |

Validé en production : 66/66 tests d'intégration · test de charge à **139 scans/min** (4 agents en parallèle, 0 erreur, 0 double entrée, p95 ≈ 1,2 s depuis Cotonou, réseau compris).

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Stack technique](#stack-technique)
- [Architecture](#architecture)
- [Démarrer en local (≈ 10 min)](#démarrer-en-local--10-min)
- [Comptes de démonstration](#comptes-de-démonstration)
- [Tests](#tests)
- [Déploiement sur Supabase](#déploiement-sur-supabase)
- [Structure du dépôt](#structure-du-dépôt)
- [Sécurité](#sécurité)
- [Roadmap « si production »](#roadmap--si-production-)
- [Crédits](#crédits)

---

## Fonctionnalités

| Espace | Ce que fait le backend |
|---|---|
| **Organisateur** | Inscription / connexion · création et édition d'événements avec 1 à 10 catégories de tickets · publication avec lien court · dashboard temps réel (ventes, recette, remplissage, entrées) · liste des commandes et export CSV · génération d'un code d'accès staff |
| **Acheteur** | Page publique de l'événement (places restantes en temps réel) · commande · paiement Mobile Money simulé (MTN, Moov, Celtiis) · tickets avec QR code téléchargeable en PNG |
| **Staff à l'entrée** | Connexion par code + PIN · scan avec réponse immédiate (valide / déjà scanné / invalide) · **mode hors ligne** avec synchronisation automatique au retour du réseau |

Garanties métier vérifiées par les tests :

- **Aucune survente**, même quand deux acheteurs paient la dernière place à la même seconde.
- **Un ticket = une seule entrée**, même quand deux agents scannent le même QR au même instant.
- **QR infalsifiables** (signature HMAC-SHA256 avec un secret propre à chaque événement).
- **Synchronisation hors ligne sans doublon**, même si un lot est renvoyé après une coupure.

## Stack technique

| Couche | Technologie |
|---|---|
| Base de données | PostgreSQL 17 (Supabase) · migrations SQL versionnées · fonctions PL/pgSQL transactionnelles |
| Authentification | Supabase Auth (bcrypt, JWT signés ES256 vérifiés localement) |
| API | 1 Edge Function Deno · [Hono](https://hono.dev) · validation [Zod](https://zod.dev) |
| Stockage | Supabase Storage (images de couverture) |
| Tâches planifiées | pg_cron (expiration des commandes non payées) |
| QR codes | `qrcode` (PNG) · HMAC-SHA256 (`pgcrypto`) |
| Tests | `node:test` (81 tests d'intégration) |

## Architecture

```
  Navigateur / PWA (Next.js — Vercel)
        │  HTTPS · JSON · Authorization: Bearer <jeton>
        ▼
  Supabase Edge Function « api »  (Hono + Zod)
  ├─ auth, CORS, rate limiting, format d'erreur uniforme
  ├─ routes : /auth  /events  /public  /orders  /tickets  /staff  /scan  /uploads
  │                       │ service_role
        ▼                 ▼
  Supabase Auth     PostgreSQL ── fonctions transactionnelles :
  (comptes)         │   create_order · pay_order · scan_ticket · scan_batch · event_stats …
                    ├─ RLS sur toutes les tables (lecture seule hors API)
                    ├─ pg_cron : expiration des commandes (toutes les 5 min)
                    └─ Storage : bucket « event-covers »
```

Toute la logique critique (paiement, attribution des places, scan) s'exécute **dans une transaction Postgres avec verrous** : c'est ce qui rend la survente et la double entrée impossibles. Le détail des choix est dans [DECISIONS.md](DECISIONS.md), le contrat d'API dans [docs/API.md](docs/API.md).

## Démarrer en local (≈ 10 min)

### Prérequis

- [Node.js](https://nodejs.org) 20 ou plus
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) démarré
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) 2.x

### Étapes

```bash
# 1. Cloner et installer les outils de test
git clone <url-du-depot> ticketo-backend && cd ticketo-backend
npm install

# 2. Démarrer Supabase (applique automatiquement les migrations)
supabase start
#    Machine avec peu de RAM (< 8 Go) : démarrer uniquement les services utiles
#    supabase start -x imgproxy,logflare,vector,studio,postgres-meta,mailpit,realtime

# 3. Configurer l'API
cp supabase/functions/.env.example supabase/functions/.env

# 4. Lancer l'API (laisser ce terminal ouvert)
supabase functions serve api --no-verify-jwt

# 5. Vérifier (dans un autre terminal)
curl http://127.0.0.1:54321/functions/v1/api/health
# → {"ok":true,"db":"up",…}

# 6. Charger les données de démonstration
npm run seed
```

L'API est disponible sur `http://127.0.0.1:54321/functions/v1/api`. Le front se branche avec :

```env
NEXT_PUBLIC_API_URL=http://127.0.0.1:54321/functions/v1/api
```

> La première requête peut prendre quelques secondes (compilation de l'Edge Function).

## Comptes de démonstration

`npm run seed` crée, en passant par l'API :

| | |
|---|---|
| Organisateur | `demo@ticketo.bj` / `TicketoDemo2026!` (local) |
| Événements | **Afro Night Cotonou** (3 catégories) et **Jazz sous les étoiles** à Porto-Novo (2 catégories) |
| Ventes | 20 tickets vendus (11 commandes), 5 entrées déjà scannées |
| Scanner | code staff + PIN **affichés à la fin du script** |

Le script refuse de s'exécuter deux fois sur le même compte (pas de doublons).

**Remise à zéro automatique.** Les accès démo étant publics, la démo est restaurée **chaque nuit à 3 h (heure de Cotonou)** par pg_cron : tout ce qui a été modifié, clôturé, supprimé ou ajouté sur le compte de démo revient à l'état de référence. Les identifiants, liens, codes staff, PIN et QR restent identiques ; les dates sont décalées par semaines entières pour que les événements restent à venir. L'état de référence s'enregistre avec :

```bash
npm run demo:snapshot                                              # local
node --env-file=.env.production.local scripts/demo-snapshot.mjs    # production
```

## Tests

```bash
npm test
```

81 tests d'intégration couvrant l'authentification, les événements, la page publique, la recherche et les likes, la cohérence entre les routes (tests croisés), les commandes et le paiement, les QR codes (relus par un décodeur indépendant), le staff, le scan en ligne et hors ligne, le dashboard, l'export CSV, le rate limiting et la sécurité (tentatives de contournement de l'API). Chaque fichier crée ses propres données et les supprime ; les données de démonstration ne sont pas touchées.

| Variable | Usage |
|---|---|
| `API_URL` | Cibler une autre API (ex. production) |
| `DATABASE_URL` | Base correspondante (nettoyage et vérifications) |
| `TEST_STORAGE=1` | Activer le test d'upload réel dans Storage |

Test de charge : `node scripts/load-test.mjs` (4 agents en parallèle, polling du dashboard, synchro hors ligne, vérification d'absence de double entrée).

## Déploiement sur Supabase

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push                          # migrations (tables, RLS, fonctions, pg_cron, bucket)
supabase secrets set ALLOWED_ORIGINS=https://<domaine-du-front> PUBLIC_APP_URL=https://<domaine-du-front>
supabase functions deploy api --no-verify-jwt
API_URL=https://<project-ref>.supabase.co/functions/v1/api DEMO_PASSWORD='<mot-de-passe-fort>' npm run seed
```

Dans le tableau de bord Supabase : **désactiver l'inscription publique** (Authentication → Sign In / Providers → « Allow new users to sign up » : off) — les comptes sont créés uniquement par l'API.

## Structure du dépôt

```
├── supabase/
│   ├── config.toml                 configuration locale (fonction api, auth)
│   ├── migrations/                 schéma, RLS, fonctions métier, pg_cron (ordre chronologique)
│   └── functions/
│       ├── .env.example            variables de l'API
│       └── api/
│           ├── index.ts            point d'entrée (CORS, journal, erreurs, routes)
│           ├── lib/                auth, validation, rate limiting, erreurs, config
│           └── routes/             auth, events, public, orders, tickets, staff, scan, uploads
├── tests/                          tests d'intégration (node:test)
├── scripts/
│   ├── seed-demo.mjs               données de démonstration (assets/ : affiches)
│   ├── demo-snapshot.mjs           état de référence de la remise à zéro nocturne
│   └── load-test.mjs               test de charge
├── docs/API.md                     documentation de l'API (30 routes)
├── DECISIONS.md                    décisions techniques
└── BACKEND_ROADMAP.md              suivi des phases du projet
```

## Sécurité

- Mots de passe et PIN staff hachés (bcrypt) ; jeton staff stocké sous forme d'empreinte uniquement.
- QR signés HMAC-SHA256 ; le secret ne quitte jamais le serveur (le mode hors ligne n'utilise que des empreintes).
- RLS sur toutes les tables ; aucune écriture directe possible hors API (testé).
- Validation stricte de toutes les entrées (champs inconnus refusés) ; URL d'image limitée à http(s).
- Rate limiting par IP (non falsifiable via `X-Forwarded-For`) et par agent pour le scan.
- Export CSV protégé contre l'injection de formules ; aucun détail technique dans les erreurs ; aucune donnée personnelle dans les journaux.

## Roadmap « si production »

- Intégration d'un vrai agrégateur Mobile Money (FedaPay, KkiaPay ou CinetPay) avec webhooks de confirmation.
- Envoi automatique des tickets par WhatsApp Business API (aujourd'hui : lien `wa.me`).
- Réservation temporaire des places pendant le paiement.
- Remboursements, annulations et transfert de tickets entre acheteurs.
- Multi-organisation avec rôles (gérant, comptable, agent), double authentification.
- Vérification de l'email à l'inscription et réinitialisation du mot de passe.
- Supervision (alertes, tableaux de bord d'erreurs) et sauvegardes planifiées.

## Crédits

Conçu et développé par **Arif** (back-end) et **Jude** (front-end) pour l'agence **WANE**.

Affiches de démonstration (domaine public, CC0) : *Crowd People* par Anthony Delanoix (StockSnap) · *Musician Playing Saxophone* (Image Catalog, Flickr).
