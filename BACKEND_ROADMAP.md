# TICKETO — Feuille de route Backend (Supabase)

> Responsable : Arif (Back-end) · Documents sources : Cahier des charges v1.0, PRD v1.0, Plan par phases v1.0
> Cible de déploiement : **Supabase** (Postgres + Auth + Storage + Edge Functions + pg_cron)
>
> Légende : `[x]` terminé · `[ ]` à faire · `[~]` en cours / partiel · ⏸ bloqué (action requise)

## Adaptation de la stack (PRD → Supabase)

| PRD (initial)                     | Implémentation Supabase                                                         |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Neon Postgres                     | Postgres Supabase                                                                |
| Prisma + migrations Prisma        | Migrations SQL versionnées (`supabase/migrations`) + fonctions PL/pgSQL          |
| Better-Auth / Lucia, cookie       | Supabase Auth (bcrypt), JWT `Authorization: Bearer` (front et API sur 2 domaines) |
| Routes Next.js `/api/*`           | 1 Edge Function `api` (Hono + Zod) → `https://<ref>.supabase.co/functions/v1/api/*` |
| uploadthing                       | Supabase Storage, bucket public `event-covers`                                   |
| Job "PENDING > 15 min"            | `pg_cron` toutes les 5 min + vérification paresseuse à la lecture               |
| Rate limiting                     | Compteur à fenêtre fixe en Postgres (pas de Redis, conforme au plan)              |
| IDs `cuid()`                      | `uuid` (`gen_random_uuid()`)                                                     |

Les détails sont dans [DECISIONS.md](DECISIONS.md).

---

## PHASE 0 — Setup (J1) ✅ TERMINÉE

- [x] Initialiser le dépôt git + `supabase init` (`project_id = ticketo`)
- [x] Configurer `config.toml` (mot de passe ≥ 8, fonction `api` avec `verify_jwt = false`)
- [x] Migration initiale : enums, tables `profiles`, `events`, `event_secrets`, `ticket_categories`, `orders`, `order_items`, `tickets`, `scan_events`, `staff_sessions`, `rate_limits`
- [x] Contraintes d'intégrité (`sold <= quantity`, prix ≥ 0, opérateurs autorisés, `ends_at > starts_at`)
- [x] Trigger `auth.users` → `profiles` (nom de l'organisateur)
- [x] Trigger `updated_at` sur `events`
- [x] RLS activée sur toutes les tables + politiques (propriétaire, lecture publique des événements publiés)
- [x] Squelette Edge Function `api` (Hono, CORS, gestion d'erreurs uniforme `{ error: { code, message, field? } }`)
- [x] Endpoint `GET /api/health` → `{ ok: true }`
- [x] `.env.example` documenté (`supabase/functions/.env.example`)
- [x] `supabase/seed.sql` initial vide
- [x] Démarrage local + migration appliquée sans erreur. Pile allégée faute de RAM (6,9 Go) : `supabase start -x imgproxy,logflare,vector,studio,postgres-meta,mailpit,realtime,storage-api` (Storage à réintégrer pour l'upload)

**Livrable :** `GET /api/health` répond `{ ok: true }` en local.

## PHASE 1 — Auth + création d'événement (J2-J3) ✅ TERMINÉE (upload réel à tester en ligne)

- [x] `POST /api/auth/signup` → 201 `{ user, session }`
- [x] `POST /api/auth/login` → 200 `{ user, session }`
- [x] `POST /api/auth/refresh` → nouveau token (ajout rendu nécessaire par le JWT)
- [x] `POST /api/auth/logout` → 204
- [x] `GET /api/auth/me` → 200 `{ user }` ou 401
- [x] Middleware `requireOrganizer` (vérification JWT Supabase)
- [x] `GET /api/events` (liste avec ventes et recette par événement)
- [x] `POST /api/events` (événement + catégories, de 1 à 10)
- [x] `GET /api/events/:id` (détail + catégories + stats)
- [x] `PATCH /api/events/:id` (mise à jour partielle, catégories ajoutées, modifiées ou supprimées)
- [x] `DELETE /api/events/:id` (refusé si des tickets sont vendus)
- [x] Vérification de propriété sur toutes les mutations
- [x] Validation Zod stricte de tous les payloads (toutes les routes, champs inconnus refusés)
- [x] Génération automatique du slug court et unique
- [x] Correctif : suppression d'un événement ayant des commandes non payées (migration `…000400_fix_category_fk_cascade`)
- [x] Upload de la couverture (validé en production) : bucket `event-covers` ✅ · endpoint `POST /api/uploads/cover` écrit ✅ · contrôles testés en local ✅ (auth, fichier absent, type réel par signature binaire, 5 Mo max) · ⏸ enregistrement réel dans Storage à tester sur le projet Supabase en ligne (Storage ne démarre pas en local : CPU trop lent)

**Livrable :** inscription, connexion, création d'un événement avec 3 catégories, liste, édition, suppression.

## PHASE 2 — Page publique + panier (J4-J5) ✅ TERMINÉE

- [x] `POST /api/events/:id/publish` (vérifie qu'au moins une catégorie existe, renvoie `slug` et `publicUrl`)
- [x] `POST /api/events/:id/close` (passe l'événement en CLOSED)
- [x] `GET /api/public/events/:slug` (sans données organisateur ni secrets)
- [x] Quota restant en temps réel (`remaining = quantity - sold`), indicateurs `isSoldOut`, `isPast`, `isSalesOpen`, `minPriceFcfa`
- [x] Cache 30 s : en-tête HTTP `Cache-Control: public, max-age=30, s-maxage=30, stale-while-revalidate=30` + cache mémoire de l'instance (`X-Cache: HIT/MISS`)

**Livrable :** un événement publié est accessible par son slug.

## PHASE 3 — Paiement simulé + tickets (J6-J7) ✅ TERMINÉE

- [x] Secret HMAC par événement (`event_secrets.qr_secret`, jamais exposé) — créé automatiquement par trigger (Phase 0)
- [x] `POST /api/orders` : création PENDING, vérification des quotas, `paymentReference`, renvoie `paymentUrl`
- [x] Fonction SQL `pay_order` transactionnelle : verrouillage, idempotence, expiration, `sold` incrémenté atomiquement (aucune survente)
- [x] `POST /api/orders/:id/simulate-payment` → `{ order, tickets }`
- [x] Payload QR `TCKT.{ticketId}.{HMAC_SHA256 base64url}` (+ `qr_hash` = sha256 pour la validation hors ligne)
- [x] `GET /api/orders/:id` (public via lien direct, expiration paresseuse)
- [x] `GET /api/tickets/:id/qr.png` (PNG généré à la volée, mis en cache, `?download=1`) — décodage vérifié par un lecteur QR indépendant
- [x] `pg_cron` : commandes PENDING de plus de 15 min passées en FAILED (toutes les 5 min) — exécution réelle constatée + tâche de ménage horaire (rate limits, sessions staff)

**Livrable :** achat de bout en bout, tickets QR scannables par une app tierce.

## PHASE 4 — Scanner en ligne (J8-J9) ✅ TERMINÉE

- [x] `POST /api/events/:id/staff-code` (code de 6 caractères + PIN de 4 chiffres, PIN haché en bcrypt, affiché une seule fois, anciennes sessions révoquées)
- [x] `POST /api/staff/login` → `{ eventId, eventName, token, ticketHashes, tickets, scannedCount }`
- [x] `GET /api/staff/tickets` (rafraîchissement de l'index hors ligne pour les tickets vendus après la connexion)
- [x] Fonction SQL `scan_ticket` : signature HMAC, bon événement, verrou de ligne, OK / DUPLICATE / INVALID
- [x] `POST /api/scan` → `{ result, holderName?, category?, previousScanAt?, scannedCount }`
- [x] Journalisation dans `scan_events` (y compris les scans invalides)
- [x] Rate limiting : 100 req/min par IP sur le scan, 10 req/min sur la connexion staff, 10 sur l'auth (inscription, connexion, refresh), 60 sur les commandes, 120 sur le paiement (relevées à cause du CGNAT des opérateurs mobiles) — IP non falsifiable (dernier élément de X-Forwarded-For)

**Livrable :** premier scan vert, deuxième scan rouge "Déjà scanné à HH:MM".

## PHASE 5 — Scanner hors ligne (J10) ✅ TERMINÉE

- [x] `POST /api/scan/batch` (500 scans max par lot, triés par `scannedAt`) — 500 scans traités en ~1 s
- [x] Résolution des conflits : le premier scan gagne, les suivants sont renvoyés en DUPLICATE (+ liste `conflicts`)
- [x] `scanned_at` client conservé (borné à l'heure serveur), `synced_at` = heure serveur
- [x] Idempotence de la synchro (une même requête renvoyée ne crée pas de doublon)

**Livrable :** 3 scans hors ligne synchronisés et visibles dans le dashboard.

## PHASE 6 — Dashboard temps réel (J11) ✅ TERMINÉE

- [x] Fonction SQL `event_stats` en une seule requête (KPI, ventes par catégorie, séries horaires ventes et entrées) — ~20-50 ms
- [x] `GET /api/events/:id/stats` (`Cache-Control: no-store`, adapté à un polling de 10 s) — chiffres vérifiés à la main
- [x] Optimisation de l'auth organisateur : vérification locale du JWT (`getClaims`, clé publique JWKS) + contrôle de session en base → ~55 ms au lieu de 300-1300 ms ; polling des stats 64-121 ms (déconnexion toujours immédiate)
- [x] `GET /api/events/:id/orders?page=&pageSize=&status=` paginé (tri du plus récent, filtre statut, page au-delà de la fin = liste vide)
- [x] `GET /api/events/:id/orders/export.csv` (UTF-8 avec BOM pour Excel, séparateur « ; », heure de Cotonou, protection contre l'injection de formules CSV)
- [x] Index SQL pour les stats (aucune requête N+1) — index créés en Phase 0, stats en une requête

**Livrable :** le dashboard se met à jour pendant les scans, export CSV disponible.

## PHASE 7 — Nettoyage, seed, documentation (J12-J13) ✅ TERMINÉE

- [x] Seed de démo : 1 organisateur, 2 événements, 5 catégories, 20 tickets vendus, 5 scannés — `scripts/seed-demo.mjs` (passe par l'API, fonctionne en local et en production, refuse les doublons)
- [x] Documentation API (`docs/API.md`) avec des exemples de payloads — 27 routes, codes d'erreur, limites, guide hors ligne, écarts avec le PRD
- [x] `.env.example` à jour, aucun secret dans le dépôt (3 variables utilisées = 3 documentées)
- [x] Logs propres sans données sensibles (ni téléphone, ni PIN, ni token) — 8 `console.*` relus
- [x] Tests d'intégration automatisés (`tests/`, `npm test`) : 55 tests, 9 fichiers — 54 OK + 1 ignoré (Storage, à activer en ligne avec TEST_STORAGE=1). ⚠ Le test « image de 6 Mo » passe seul mais peut échouer en suite complète en local (limite CPU cumulée des workers sur la machine de dev) : à revérifier en production
- [x] Test de charge basique (100 scans/min) — confirmé en production (139 scans/min) : `scripts/load-test.mjs` écrit et exécuté en local — limite de scan passée PAR AGENT (wifi partagé) ; réessai par clientScanId documenté et testé ; 0 double entrée ✔, synchro de 100 scans en 0,7 s ✔, mais débit et latences non représentatifs (workers locaux arrêtés par la limite CPU de la machine de dev). À relancer en production (Phase 8)
- [x] Revue sécurité (RLS, propriété, secrets, CORS) — corrigé : écriture directe en base retirée (survente possible), URL de couverture limitée à http(s) (XSS), inscription publique Supabase désactivée ; `_drafts/` supprimé ; 55 tests (54 OK, 1 ignoré)

## PHASE 8 — Déploiement Supabase + livrables (J14)

- [x] Pousser le dépôt sur le GitHub personnel d'Arif — https://github.com/arifchitou6-bit/tiketo (branche main, commit a9e2b32)
- [x] Projet Supabase de production : « arifchitou6-bit's Project » (ref yedvgoroseersrjyyfol), organisation personnelle « Tiketo », région eu-west-3 — mot de passe dans .env.production.local (exclu de git)
- [x] `supabase link --project-ref yedvgoroseersrjyyfol` — base en ligne vérifiée vide avant déploiement
- [x] `supabase db push` — 16 migrations appliquées en production
- [~] Secrets : configuration TEMPORAIRE (`PUBLIC_APP_URL=http://localhost:3000`, `ALLOWED_ORIGINS` non défini = toutes origines) — à remplacer par l'adresse Vercel du front
- [x] `supabase functions deploy api` — https://yedvgoroseersrjyyfol.supabase.co/functions/v1/api (health OK)
- [x] Vérifier que pg_cron est actif et que le bucket Storage existe en production (2 tâches actives, bucket event-covers, 0 droit d'écriture directe)
- [x] Désactiver l'inscription publique dans le tableau de bord — vérifié : inscription directe → 422 signup_disabled, inscription via l'API → 201 (Auth > Sign In / Providers > « Allow new users to sign up » : NON) — équivalent de `enable_signup = false`
- [x] Seed de démo en production (mot de passe généré, non par défaut) — accès documentés dans le README et .env.production.local
- [x] Test de charge en production : 139 scans/min (4 agents), 149/149 HTTP 200, médiane 774 ms et p95 1,2 s depuis Cotonou (réseau compris), dashboard 0 erreur, synchro 100 scans en 1,7 s, 0 double entrée ✔
- [x] Tests en production : 55/55 (49 au 1er passage ; 6 échecs dus au pare-feu Cloudflare, au cache par instance, à une coupure DNS et à un test trop lent — tests ajustés puis relancés : 13/13). Données de test supprimées
- [x] Vérifier que le projet utilise des clés de signature JWT asymétriques — ES256 ✔ (Auth > JWT Keys) : sinon `getClaims()` repasse par le service Auth à chaque requête (correct mais plus lent)
- [x] Vérifier la détection de l'IP client en production — faux X-Forwarded-For toujours bloqué ✔ (rate limiting) : envoyer un faux `X-Forwarded-For` ne doit pas changer de compteur
- [x] Tester l'upload réel d'une couverture — enregistrement Storage + URL publique accessible ✔
- [ ] Vérifier le CORS en production : seules les origines `ALLOWED_ORIGINS` sont acceptées (en local, la passerelle Kong force `*`)
- [x] README backend pro + DECISIONS.md (18 décisions) — URL de production et comptes de démo ajoutés
- [~] Transmettre au front (Jude) l'URL de base de l'API (message prêt, envoi par Arif ; la clé anon n'est pas nécessaire : tout passe par l'API)

## PHASE 9 — Retours de Jude (PRD v2) et démo

**Indépendant du PRD v2**

- [x] Affiches des événements de démo — 2 photos libres de droits (CC0) dans `scripts/assets/`, envoyées par le seed via `/uploads/cover`
- [x] Remise à zéro automatique de la démo — migration `20261009000100_demo_reset.sql` : photo de référence (`demo_snapshot`) + restauration à l'identique chaque nuit à 3 h (Cotonou) par pg_cron (`demo_reset`), dates décalées par semaines entières pour rester à venir ; testé en local (vandalisme → restauration identique)
- [x] Production : migration appliquée, affiches posées sur les 2 événements (images publiques HTTP 200), photo de référence prise, tâche pg_cron `ticketo-demo-reset` active (0 2 * * * UTC) ; remise à zéro lancée une fois : 20 tickets, QR identiques, connexion staff X3RSGG OK

**Dépend du PRD v2 (en attente du document de Jude)**

- [x] Base de données : `category` (6 valeurs, défaut SOIREE), `country` (ISO 2 lettres, défaut BJ), `timeZone` (IANA, défaut Africa/Porto-Novo), `coverFit` (cover|contain), `description` des catégories (300 car.), table `event_likes` + `likesCount` — migration `20261009000200_event_fields_v2.sql`, champs dans la création/modification, le détail organisateur, la liste et la page publique ; photo de la démo complétée ; 4 tests ajoutés, 59/59 en local. ✅ En production (déployé, démo complétée : Jazz = CONCERT, descriptions des catégories, nouvelle photo de référence)
- [x] `GET /public/events` : recherche sans accents (unaccent), filtres catégorie/pays, tri date|popular, pagination par curseur (keyset), `limit`, `isLiked` avec deviceId ; `POST`/`DELETE /public/events/:slug/like` (idempotents, 60/min) — migration `20261009000300_public_list_likes.sql`, doc API à jour, 7 tests, 66 en local (65 OK, 1 ignoré : Storage). ✅ En production : 62/66 (7/7 sur la liste et les likes) ; 4 échecs non liés au code : 3 coupures réseau (ECONNRESET) et 1 horloge du PC de dev en retard de 8 h 30 ; données de test supprimées
- [ ] Compte acheteur par code e-mail (OTP) : `/buyer/otp/request`, `/buyer/otp/verify`, `/buyer/me`, `/buyer/logout`, `/buyer/orders`, `/buyer/favorites` — service d'envoi d'e-mails à choisir
- [ ] Tests des nouveautés + non-régression des 55 tests
- [ ] Documentation, déploiement, nouvelle photo de la démo, message pour Jude
