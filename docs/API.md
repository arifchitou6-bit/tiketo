# TICKETO — Documentation de l'API

> Pour : l'équipe front (Jude) et tout développeur qui intègre TICKETO.
> Toutes les routes ci-dessous sont implémentées et testées. Les exemples sont des réponses réelles.

## Sommaire

1. [Démarrage](#1-démarrage)
2. [Conventions](#2-conventions)
3. [Authentification](#3-authentification)
4. [Routes](#4-routes) : [Santé](#41-santé) · [Auth](#42-auth-organisateur) · [Événements](#43-événements-organisateur) · [Upload](#44-upload-dimage) · [Public](#45-pages-publiques) · [Commandes](#46-commandes-et-paiement) · [Tickets](#47-tickets) · [Staff](#48-staff) · [Scan](#49-scan)
5. [Codes d'erreur](#5-codes-derreur)
6. [Limites de requêtes](#6-limites-de-requêtes-rate-limiting)
7. [Guide : scanner hors ligne](#7-guide--scanner-hors-ligne)
8. [Écarts avec le PRD](#8-écarts-avec-le-prd-v10)

---

## 1. Démarrage

| Environnement | URL de base |
|---|---|
| Local | `http://127.0.0.1:54321/functions/v1/api` |
| Production | `https://<project-ref>.supabase.co/functions/v1/api` |

Dans le front (`.env.local`) :

```env
NEXT_PUBLIC_API_URL=http://127.0.0.1:54321/functions/v1/api
```

Vérifier que l'API tourne :

```bash
curl http://127.0.0.1:54321/functions/v1/api/health
# {"ok":true,"db":"up","time":"2026-10-07T06:58:59.147Z"}
```

Comptes de démo : voir `node scripts/seed-demo.mjs` (affiche identifiants, codes staff et PIN).

---

## 2. Conventions

| Sujet | Règle |
|---|---|
| Format | JSON en entrée et en sortie (`Content-Type: application/json`), sauf upload (multipart), image QR (PNG) et export (CSV) |
| Nommage | `camelCase` dans tous les payloads |
| Dates | ISO 8601 **en UTC** (`2026-12-20T20:00:00Z`). Conversion en heure locale uniquement à l'affichage |
| Montants | Entiers en **FCFA** (pas de décimales) : `15000` |
| Identifiants | UUID v4 (`"07a3b67b-6ec8-4372-93f8-547990f2a9e2"`) |
| Validation | Stricte : **tout champ non prévu est refusé** (`400`, « Champ non autorisé : … ») |
| Erreurs | Toujours `{ "error": { "code", "message", "field"? } }` — voir [§5](#5-codes-derreur). Messages **toujours en français** |
| Taille | Corps JSON limité à **1 Mo** (`413 PAYLOAD_TOO_LARGE`) ; images : 5 Mo |
| Méthodes | Méthode non prévue sur une route existante → `405 METHOD_NOT_ALLOWED` + en-tête `Allow` (ex. `PUT /events` → `Allow: GET, POST`) |
| Fuseau | Afficher les dates dans `event.timeZone` (heure du lieu), présent sur l'événement, la commande et la connexion staff |

Exemple d'erreur de validation :

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Le prix ne peut pas être négatif", "field": "categories.1.priceFcfa" } }
```

`field` indique le champ en cause (chemin avec points pour les objets imbriqués) : à utiliser pour afficher l'erreur sous le bon input. `message` est en français, prêt à être affiché.

---

## 3. Authentification

Trois niveaux d'accès :

| Qui | Comment | Routes |
|---|---|---|
| Public (acheteur) | Aucune authentification | `/public/*`, `/orders/*`, `/tickets/*`, `/health` |
| Organisateur | `Authorization: Bearer <accessToken>` (jeton Supabase Auth) | `/auth/me`, `/auth/logout`, `/events/*`, `/uploads/*` |
| Staff (agent de porte) | `Authorization: Bearer <token staff>` (reçu à `/staff/login`) | `/staff/tickets`, `/scan`, `/scan/batch` |

### Cycle de vie de la session organisateur

1. `POST /auth/login` (ou `/auth/signup`) renvoie une `session` :
   ```json
   { "accessToken": "eyJhbGciOiJFUzI1NiIs…", "refreshToken": "lqsfhhm3ody6", "expiresIn": 3600,
     "expiresAt": "2026-10-07T08:16:23.000Z", "tokenType": "bearer" }
   ```
2. Envoyer `Authorization: Bearer <accessToken>` sur chaque requête organisateur.
3. Le jeton expire après **1 heure**. Avant `expiresAt` (ou sur une réponse `401`), appeler `POST /auth/refresh` avec le `refreshToken` pour obtenir une nouvelle session. **Le `refreshToken` change à chaque renouvellement** : toujours garder le dernier.
4. `POST /auth/logout` invalide la session immédiatement.

> Stockage côté front : garder la session en mémoire + `localStorage` (ou cookie posé par le front lui-même). L'API ne pose aucun cookie (front et API sont sur deux domaines différents).

Le jeton staff est opaque (64 caractères), valable jusqu'à **12 h après la fin de l'événement**. Il est révoqué si l'organisateur régénère le code staff.

---

## 4. Routes

Légende : 🌐 public · 🔑 organisateur · 🛂 staff

### 4.1 Santé

#### `GET /health` 🌐

```json
200 { "ok": true, "db": "up", "time": "2026-10-07T06:58:59.147Z" }
503 { "ok": false, "db": "down" }
```

### 4.2 Auth organisateur

#### `POST /auth/signup` 🌐 — US-01

```json
{ "email": "marc@test.bj", "password": "motdepasse123", "name": "Marc DJ" }
```

| Champ | Règle |
|---|---|
| `email` | Email valide, normalisé en minuscules |
| `password` | 8 à 72 caractères |
| `name` | 2 à 120 caractères |

```json
201 {
  "user": { "id": "cd78f691-bafd-4667-8da2-81af5e4a110e", "email": "marc@test.bj", "name": "Marc DJ",
            "createdAt": "2026-10-07T07:16:18.829892+00:00" },
  "session": { "accessToken": "…", "refreshToken": "…", "expiresIn": 3600, "expiresAt": "…", "tokenType": "bearer" }
}
```

Le compte est actif immédiatement (pas d'email de confirmation). Erreurs : `400 VALIDATION_ERROR`, `409 EMAIL_TAKEN` (`field: "email"`), `429`.

#### `POST /auth/login` 🌐 — US-02

```json
{ "email": "marc@test.bj", "password": "motdepasse123" }
```

`200 { user, session }` (même format que signup). Erreurs : `401 INVALID_CREDENTIALS` (« Email ou mot de passe incorrect »), `429`.

#### `POST /auth/refresh` 🌐

```json
{ "refreshToken": "lqsfhhm3ody6" }
```

`200 { "session": { … } }`. Erreur : `401 INVALID_REFRESH_TOKEN` → renvoyer vers la page de connexion.

#### `POST /auth/logout` 🔑

`204` (sans corps).

#### `GET /auth/me` 🔑

`200 { "user": { "id", "email", "name", "createdAt" } }` ou `401 UNAUTHORIZED`.

### 4.3 Événements (organisateur)

Toutes ces routes renvoient **`404 NOT_FOUND`** si l'événement n'existe pas **ou appartient à un autre organisateur** (on ne révèle pas son existence).

#### Objet `event` (détail)

```json
{
  "id": "07a3b67b-6ec8-4372-93f8-547990f2a9e2",
  "slug": "afro-night-cotonou-w489",
  "name": "Afro Night Cotonou",
  "description": "La soirée afrobeats de l'année.",
  "category": "SOIREE",
  "coverImageUrl": null,
  "coverFit": "cover",
  "venue": "Le Code Bar",
  "city": "Cotonou",
  "country": "BJ",
  "timeZone": "Africa/Porto-Novo",
  "startsAt": "2026-12-20T20:00:00+00:00",
  "endsAt": "2026-12-21T04:00:00+00:00",
  "status": "DRAFT",
  "likesCount": 0,
  "staffCode": null,
  "publishedAt": null,
  "createdAt": "2026-10-07T07:23:27.081881+00:00",
  "updatedAt": "2026-10-07T07:23:27.081881+00:00",
  "categories": [
    { "id": "ed5bf041-…", "name": "Standard", "description": "", "priceFcfa": 5000, "quantity": 100, "sold": 10, "remaining": 90 }
  ],
  "stats": { "capacity": 120, "ticketsSold": 10, "revenue": 50000, "fillRate": 8.3, "scannedCount": 0 }
}
```

`status` : `DRAFT` (brouillon) → `PUBLISHED` (en vente) → `CLOSED` (billetterie fermée).

| Champ (PRD v2) | Valeurs | Défaut |
|---|---|---|
| `category` | `CONCERT`, `SOIREE`, `FESTIVAL`, `CONFERENCE`, `THEATRE`, `EXPOSITION` | `SOIREE` |
| `country` | code pays ISO 3166-1 à 2 lettres (`BJ`, `TG`, `CI`…), minuscules acceptées | `BJ` |
| `timeZone` | fuseau IANA (`Africa/Porto-Novo`, `Africa/Lome`…) : pour afficher l'heure locale du lieu | `Africa/Porto-Novo` |
| `coverFit` | `cover` (l'image remplit le cadre, rognée) ou `contain` (image entière) — à passer en `object-fit` | `cover` |
| `likesCount` | nombre de likes (lecture seule) | `0` |
| `categories[].description` | texte libre, 300 caractères max | `""` |

#### `GET /events` 🔑 — US-02 (liste du dashboard)

```json
200 { "events": [ {
  "id": "…", "slug": "afro-night-cotonou-ht3p", "name": "Afro Night Cotonou", "status": "PUBLISHED",
  "category": "SOIREE", "venue": "Le Code Bar, Haie Vive", "city": "Cotonou", "country": "BJ",
  "timeZone": "Africa/Porto-Novo", "coverImageUrl": "https://…", "coverFit": "cover", "likesCount": 3,
  "startsAt": "…", "endsAt": "…", "publishedAt": "…", "createdAt": "…",
  "capacity": 365, "ticketsSold": 12, "revenue": 235000, "scannedCount": 5
} ] }
```

Triés par date de début décroissante. Liste vide → `{ "events": [] }` (état « Aucun événement encore »).

#### `POST /events` 🔑 — US-03, US-04

```json
{
  "name": "Afro Night — Cotonou 2026 !",
  "description": "La soirée afrobeats de l'année.",
  "venue": "Le Code Bar",
  "city": "Cotonou",
  "startsAt": "2026-12-20T20:00:00Z",
  "endsAt": "2026-12-21T04:00:00Z",
  "coverImageUrl": "https://…/event-covers/…/photo.jpg",
  "category": "SOIREE",
  "country": "BJ",
  "timeZone": "Africa/Porto-Novo",
  "coverFit": "cover",
  "categories": [
    { "name": "Standard", "priceFcfa": 5000, "quantity": 200 },
    { "name": "VIP", "priceFcfa": 15000, "quantity": 50, "description": "Accès carré VIP + 1 boisson" }
  ]
}
```

| Champ | Règle |
|---|---|
| `name` | 2 à 140 caractères |
| `description` | optionnelle, 10 000 caractères max |
| `venue` / `city` | obligatoires (160 / 80 caractères max) |
| `startsAt` / `endsAt` | ISO 8601, `endsAt` après `startsAt` |
| `coverImageUrl` | optionnelle, URL (voir [upload](#44-upload-dimage)) |
| `category`, `country`, `timeZone`, `coverFit` | optionnels (valeurs et défauts : voir l'objet `event` ci-dessus) |
| `categories[].description` | optionnelle, 300 caractères max |
| `categories` | 1 à 10, noms uniques (insensible à la casse) |
| `priceFcfa` | entier 0 à 10 000 000 |
| `quantity` | entier 1 à 100 000 |

`201 { "event": { … } }` — créé en `DRAFT`, avec un slug généré automatiquement (`afro-night-cotonou-2026-96tt`, définitif).

#### `GET /events/:id` 🔑

`200 { "event": { … } }`

#### `PATCH /events/:id` 🔑 — US-04

Mise à jour partielle : n'envoyer que les champs modifiés. `coverImageUrl: null` retire l'image.

Si `categories` est envoyé, c'est **la liste complète souhaitée** :

- catégorie **avec** `id` → modifiée ;
- catégorie **sans** `id` → créée ;
- catégorie existante **absente** de la liste → supprimée.

```json
{
  "name": "Afro Night Cotonou",
  "categories": [
    { "id": "28016144-…", "name": "Standard", "priceFcfa": 5000, "quantity": 200 },
    { "id": "68f7b35a-…", "name": "VIP", "priceFcfa": 20000, "quantity": 50 },
    { "name": "Early Bird", "priceFcfa": 3000, "quantity": 100 }
  ]
}
```

`200 { "event": { … } }`. Le slug ne change jamais (les liens partagés restent valides).

Erreurs : `400` (aucun champ / validation), `409 QUANTITY_BELOW_SOLD` (quantité < tickets déjà vendus), `409 CATEGORY_HAS_ORDERS` (suppression d'une catégorie qui a des commandes), `409 EVENT_CLOSED`, `422 CATEGORY_NOT_FOUND`.

#### `DELETE /events/:id` 🔑

`204`. Refusé avec `409 EVENT_HAS_SALES` si au moins une commande est payée (les paniers abandonnés sont supprimés avec l'événement).

#### `POST /events/:id/publish` 🔑 — US-05, US-06

```json
200 {
  "slug": "afro-night-cotonou-i3id",
  "publicUrl": "http://localhost:3000/events/afro-night-cotonou-i3id",
  "event": { … }
}
```

`publicUrl` est le lien à copier en un clic. Idempotent (republier ne fait rien). Erreurs : `409 EVENT_ENDED` (`field: "endsAt"`), `409 EVENT_CLOSED`, `422 NO_CATEGORY`.

#### `POST /events/:id/close` 🔑

Ferme la billetterie (`CLOSED`) : plus aucune commande. La page publique reste visible. `200 { "event": { … } }`. Idempotent. Erreur : `409 EVENT_NOT_PUBLISHED` (un brouillon se supprime, il ne se clôt pas).

#### `POST /events/:id/staff-code` 🔑 — US-09

```json
201 { "code": "GAE9CK", "pin": "2938", "scannerUrl": "http://localhost:3000/scanner" }
```

⚠️ **Le PIN n'est renvoyé qu'une seule fois** (stocké haché) : l'afficher dans la modale avec un bouton copier. Régénérer un code **déconnecte immédiatement** les agents connectés avec l'ancien.

#### `GET /events/:id/stats` 🔑 — US-07 (polling toutes les 10 s)

```json
200 { "stats": {
  "ticketsSold": 7, "capacity": 120, "revenue": 80000, "fillRate": 5.8, "scannedCount": 2,
  "orders": { "paid": 3, "pending": 1, "failed": 1 },
  "byCategory": [
    { "categoryId": "…", "name": "Standard", "priceFcfa": 5000, "quantity": 100, "sold": 3, "remaining": 97, "revenue": 15000, "scanned": 1 },
    { "categoryId": "…", "name": "VIP", "priceFcfa": 20000, "quantity": 20, "sold": 4, "remaining": 16, "revenue": 65000, "scanned": 1 }
  ],
  "salesOverTime": [ { "bucket": "2026-10-07T08:00:00+00:00", "tickets": 7, "revenue": 80000 } ],
  "scansOverTime": [ { "bucket": "2026-10-07T08:45:00+00:00", "count": 2 } ],
  "generatedAt": "2026-10-07T08:46:12.000Z"
} }
```

- 4 KPI : `ticketsSold`, `revenue`, `fillRate` (%), `scannedCount`.
- `byCategory` → chart barres. `scansOverTime` (tranches de 15 min) → chart ligne. `salesOverTime` : tranches d'1 h.
- `revenue` utilise le prix **payé au moment de l'achat** (un changement de prix ne fausse pas la recette).
- Jamais mis en cache (`Cache-Control: no-store`).

#### `GET /events/:id/orders?page=1&pageSize=20&status=PAID` 🔑 — US-08

| Paramètre | Défaut | Règle |
|---|---|---|
| `page` | 1 | ≥ 1 |
| `pageSize` | 20 | 1 à 100 |
| `status` | (tous) | `PAID`, `PENDING` ou `FAILED` |

```json
200 {
  "orders": [ {
    "id": "…", "status": "PAID", "buyerName": "Aïcha Kpèdétin", "buyerPhone": "+22997112233", "buyerEmail": null,
    "paymentProvider": "mtn", "paymentReference": "TKO-RE2G7BP87Z", "totalAmount": 25000, "ticketCount": 3,
    "summary": "2× Standard, 1× VIP",
    "items": [ { "categoryName": "Standard", "quantity": 2, "unitPriceFcfa": 5000 }, { "categoryName": "VIP", "quantity": 1, "unitPriceFcfa": 15000 } ],
    "failureReason": null, "createdAt": "…", "paidAt": "…"
  } ],
  "pagination": { "page": 1, "pageSize": 20, "total": 25, "totalPages": 2 }
}
```

Tri du plus récent au plus ancien. Une page au-delà de la fin renvoie `orders: []` avec le vrai `total`.

#### `GET /events/:id/orders/export.csv` 🔑 — US-08

Fichier `acheteurs-<événement>.csv` (`Content-Disposition: attachment`) avec les commandes **payées** : référence, nom, téléphone, email, opérateur, tickets, nombre, montant, date de paiement (heure de Cotonou). UTF-8 avec BOM et séparateur `;` (Excel en français). Les cellules commençant par `= + - @` sont préfixées d'une apostrophe (protection contre l'injection de formules).

Téléchargement côté front (le jeton doit être envoyé, un simple lien `<a href>` ne suffit pas) :

```js
const res = await fetch(`${API}/events/${id}/orders/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
const url = URL.createObjectURL(await res.blob());
Object.assign(document.createElement("a"), { href: url, download: "acheteurs.csv" }).click();
URL.revokeObjectURL(url);
```

### 4.4 Upload d'image

#### `POST /uploads/cover` 🔑

`multipart/form-data` avec le champ **`file`** (JPEG, PNG ou WebP, 5 Mo max ; le type est vérifié sur le contenu réel du fichier).

```js
const form = new FormData();
form.append("file", fichier);
const res = await fetch(`${API}/uploads/cover`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
// 201 { "url": "https://<ref>.supabase.co/storage/v1/object/public/event-covers/<uid>/<uuid>.jpg", "path": "<uid>/<uuid>.jpg" }
```

Puis envoyer `url` dans `coverImageUrl` (création ou `PATCH`). Erreurs : `400` (pas de fichier), `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`, `502 UPLOAD_FAILED`.

> ⚠️ En local, le service Storage ne démarre pas sur la machine de dev : cette route sera testée sur le projet en ligne.

### 4.5 Pages publiques

#### `GET /public/events?q=&category=&country=&sort=date&cursor=&limit=12&deviceId=` 🌐 — accueil et recherche

Événements **publiés et non terminés** (ceux en cours restent visibles). Tous les paramètres sont optionnels ; un paramètre vide (`?q=&category=`) est ignoré.

| Paramètre | Règle |
|---|---|
| `q` | recherche dans le nom, la description, le lieu et la ville ; **insensible aux accents et à la casse** ; tous les mots doivent être présents (`soiree cotonou` trouve « Soirée … » à Cotonou) ; 100 caractères max |
| `category` | une des 6 catégories (`CONCERT`, `SOIREE`…) |
| `country` | code pays à 2 lettres (`BJ`) |
| `sort` | `date` (défaut : le plus proche d'abord) ou `popular` (le plus de likes d'abord, puis par date) |
| `limit` | 1 à 50 (défaut 12) |
| `cursor` | valeur `nextCursor` de la page précédente, **à renvoyer telle quelle avec les mêmes filtres et le même tri** |
| `deviceId` | optionnel : ajoute `isLiked` à chaque événement (voir likes ci-dessous) |

```json
200 {
  "events": [ {
    "id": "…", "slug": "afro-night-cotonou-3hhi", "name": "Afro Night Cotonou", "category": "SOIREE",
    "coverImageUrl": "https://…", "coverFit": "cover",
    "venue": "Le Code Bar, Haie Vive", "city": "Cotonou", "country": "BJ", "timeZone": "Africa/Porto-Novo",
    "startsAt": "2026-10-17T19:00:00+00:00", "endsAt": "2026-10-18T03:00:00+00:00",
    "likesCount": 3, "minPriceFcfa": 5000, "isSoldOut": false, "isSalesOpen": true,
    "isLiked": false
  } ],
  "nextCursor": "eyJvIjoiZGF0ZSIsInMiOi…"
}
```

`nextCursor: null` = dernière page (« Charger plus » masqué). Aucun résultat → `{ "events": [], "nextCursor": null }` (état vide). La pagination par curseur ne saute ni ne répète d'événement si de nouveaux sont publiés entre deux pages. Un curseur invalide ou obtenu avec un autre `sort` → `400 INVALID_CURSOR` : recharger la liste sans curseur. Cache 30 s (sauf avec `deviceId` : `private, no-store`).

#### `GET /public/events/:slug` 🌐 — US-10, US-11

```json
200 { "event": {
  "id": "…", "slug": "afro-night-cotonou-xbab", "name": "Afro Night Cotonou",
  "description": "…", "category": "SOIREE", "coverImageUrl": null, "coverFit": "cover",
  "venue": "Le Code Bar", "city": "Cotonou", "country": "BJ", "timeZone": "Africa/Porto-Novo",
  "startsAt": "2026-12-20T20:00:00+00:00", "endsAt": "2026-12-21T04:00:00+00:00",
  "status": "PUBLISHED", "likesCount": 3,
  "isPast": false, "isSoldOut": false, "isSalesOpen": true, "minPriceFcfa": 5000,
  "categories": [
    { "id": "…", "name": "Early Bird", "description": "", "priceFcfa": 3000, "remaining": 0, "isSoldOut": true },
    { "id": "…", "name": "Standard", "description": "Accès général", "priceFcfa": 5000, "remaining": 188, "isSoldOut": false }
  ]
} }
```

Avec `?deviceId=…`, la réponse contient aussi `"isLiked": true|false` et elle est **lue en direct** (pas de cache) : `likesCount`, `remaining` et `isLiked` sont toujours à jour. Sans `deviceId` (visiteur anonyme), le cache de 30 s s'applique. **Conseil : envoyer toujours `deviceId`.**

| Indicateur | Usage côté front |
|---|---|
| `isSalesOpen` | Afficher le bouton « Réserver » (publié + pas terminé + pas complet) |
| `isSoldOut` | État « Complet » |
| `isPast` | État « Événement terminé » |
| `status: "CLOSED"` | Billetterie fermée par l'organisateur |
| `minPriceFcfa` | « À partir de 5 000 FCFA » (catégories encore disponibles) |
| `categories[].remaining` | Quantité max du sélecteur |

Brouillon ou slug inconnu → `404`. Aucune donnée organisateur ni chiffre de vente. Mis en cache 30 s (`Cache-Control: public, max-age=30`) : `remaining` et `likesCount` peuvent avoir 30 s de retard, les quotas réels sont revérifiés à la commande et au paiement.

#### `POST /public/events/:slug/like` 🌐 · `DELETE /public/events/:slug/like` 🌐

```json
{ "deviceId": "3f1c9a52-7b0e-4c1d-9a8e-2f6b5c4d3e21" }
```

```json
200 { "liked": true, "likesCount": 4 }      // DELETE : { "liked": false, "likesCount": 3 }
```

- **Un like par appareil** : `deviceId` est un identifiant généré une fois par le front et conservé (ex. `crypto.randomUUID()` dans `localStorage`) ; 8 à 100 caractères parmi lettres, chiffres, `-` et `_`.
- **Idempotent** : liker deux fois ne compte qu'une fois, retirer un like absent ne fait rien. Pas besoin de bloquer le bouton pendant la requête : afficher `likesCount` renvoyé.
- `DELETE` accepte aussi `?deviceId=…` dans l'URL (pour les clients qui n'envoient pas de corps avec DELETE).
- Événements publiés ou clos uniquement (brouillon ou inconnu → `404`).

### 4.6 Commandes et paiement

#### `POST /orders` 🌐 — US-12, US-13

```json
{
  "eventSlug": "afro-night-cotonou-w489",
  "items": [ { "categoryId": "28016144-…", "quantity": 2 }, { "categoryId": "68f7b35a-…", "quantity": 1 } ],
  "buyer": { "name": "Aïcha K.", "phone": "+229 97 00 00 00", "email": "aicha@mail.bj", "provider": "mtn" }
}
```

| Champ | Règle |
|---|---|
| `items` | 1 à 10 lignes, 1 à 20 tickets au total ; une même catégorie peut apparaître deux fois (regroupée) |
| `buyer.name` | 2 à 120 caractères |
| `buyer.phone` | 8 à 15 chiffres, `+` optionnel ; espaces, points, tirets retirés automatiquement |
| `buyer.email` | optionnel (`""` accepté) |
| `buyer.provider` | `mtn`, `moov` ou `celtiis` |

Le **total est calculé par le serveur** (aucun prix n'est accepté du client).

```json
201 {
  "order": {
    "id": "a4dcef8d-95c1-4829-a918-1c65e3d68b66", "status": "PENDING",
    "buyerName": "Aïcha K.", "buyerPhone": "+22997000000", "buyerEmail": "aicha@mail.bj",
    "totalAmount": 25000, "paymentProvider": "mtn", "paymentReference": "TKO-TD4AFSQAFW",
    "failureReason": null, "createdAt": "2026-10-07T08:05:14.307846+00:00",
    "expiresAt": "2026-10-07T08:20:14.307Z", "paidAt": null,
    "event": { "id": "…", "slug": "afro-night-cotonou-w489", "name": "Afro Night Cotonou", "category": "SOIREE",
               "venue": "Le Code Bar", "city": "Cotonou", "country": "BJ", "timeZone": "Africa/Porto-Novo",
               "startsAt": "…", "endsAt": "…", "coverImageUrl": null, "coverFit": "cover" },
    "items": [
      { "categoryId": "…", "categoryName": "Standard", "quantity": 2, "unitPriceFcfa": 5000, "subtotal": 10000 },
      { "categoryId": "…", "categoryName": "VIP", "quantity": 1, "unitPriceFcfa": 15000, "subtotal": 15000 }
    ]
  },
  "paymentUrl": "http://localhost:3000/events/afro-night-cotonou-w489/checkout/pay?orderId=a4dcef8d-…"
}
```

La commande **ne réserve pas** les places : elles sont attribuées au paiement. Elle expire après **15 minutes** (`expiresAt`).

Erreurs : `400`, `404` (événement inconnu ou brouillon), `409 SOLD_OUT` (`field` = `categoryId` concerné), `409 EVENT_CLOSED`, `409 EVENT_ENDED`, `422 CATEGORY_NOT_FOUND`, `429`.

#### `POST /orders/:id/simulate-payment` 🌐 — US-14, US-15

Appelé par l'écran de paiement simulé après 3 secondes (sans corps).

```json
200 {
  "order": { …, "status": "PAID", "paidAt": "…" },
  "tickets": [ {
    "id": "b4fe1185-ed5f-49f7-91cb-476237f98e51", "categoryId": "…", "categoryName": "Standard", "holderName": "Aïcha K.",
    "qrPayload": "TCKT.b4fe1185-ed5f-49f7-91cb-476237f98e51.zQwjlCaSfPjPV71njDOXk65qHNszUqAaKbPQYhHX26o",
    "qrUrl": "http://127.0.0.1:54321/functions/v1/api/tickets/b4fe1185-…/qr.png",
    "status": "VALID", "scannedAt": null
  } ]
}
```

**Idempotent** : un double appel renvoie le même résultat, sans tickets en double.

Échecs (`409`, la commande passe en `FAILED`) :

| `code` | Message affiché | Écran conseillé |
|---|---|---|
| `ORDER_EXPIRED` | Le délai de paiement de 15 minutes est dépassé… | « Commande expirée » + retour à l'événement |
| `SOLD_OUT` | Il ne reste plus assez de tickets… | « Plus de places » + retour à l'événement |
| `EVENT_CLOSED` | La billetterie de cet événement est fermée | « Billetterie fermée » |

#### `GET /orders/:id` 🌐 — écran de succès (US-15)

`200 { "order": { … }, "tickets": [ … ] }` — même format que ci-dessus. `tickets` est vide tant que la commande n'est pas payée. Une commande `PENDING` de plus de 15 min est passée en `FAILED` (`failureReason: "ORDER_EXPIRED"`) à la lecture. Jamais mise en cache.

> Accessible à quiconque possède le lien (prévu par le PRD pour le partage WhatsApp). Les identifiants sont des UUID aléatoires, impossibles à deviner.

### 4.7 Tickets

#### `GET /tickets/:id/qr.png` 🌐 — US-16

Image PNG 600×600 du QR (lisible par n'importe quel lecteur QR). `?download=1` force le téléchargement avec un nom propre (`ticket-afro-night-cotonou-vip-ee3fe47b.png`). Mise en cache 1 an (un QR ne change jamais).

```html
<img src="{ticket.qrUrl}" alt="QR du ticket" />
<a href="{ticket.qrUrl}?download=1">Télécharger PNG</a>
```

Lien WhatsApp (US-17), construit côté front :

```js
const text = `Mes tickets pour ${order.event.name} : ${window.location.origin}/events/${order.event.slug}/success/${order.id}`;
const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
```

### 4.8 Staff

#### `POST /staff/login` 🌐 — US-18, US-19

```json
{ "code": "gae9ck", "pin": "2938", "deviceId": "android-kevin" }
```

`code` : 6 caractères (insensible à la casse) · `pin` : 4 chiffres · `deviceId` : optionnel.

```json
200 {
  "eventId": "…", "eventName": "Afro Night Cotonou", "venue": "Le Code Bar", "city": "Cotonou",
  "timeZone": "Africa/Porto-Novo", "startsAt": "…", "endsAt": "…", "expiresAt": "2026-12-21T16:00:00+00:00",
  "token": "3f9a…(64 caractères)",
  "ticketHashes": ["c8c6c83ba06aa2619f8db7fed4705d0ed41cfc2970bc7482fe46c75d531fbfae", "…"],
  "tickets": [ { "hash": "c8c6c83b…", "holderName": "Aïcha K.", "category": "Standard", "status": "VALID", "scannedAt": null } ],
  "totalTickets": 3, "scannedCount": 0, "serverTime": "…"
}
```

Erreurs : `401 INVALID_CREDENTIALS` (« Code ou PIN incorrect », volontairement identique que le code existe ou non), `409 EVENT_NOT_PUBLISHED`, `429` (10 essais/min).

#### `GET /staff/tickets` 🛂

Rafraîchit l'index hors ligne (tickets vendus après la connexion, scans des autres agents) : `200 { ticketHashes, tickets, totalTickets, scannedCount, serverTime }`.

### 4.9 Scan

#### `POST /scan` 🛂 — US-20 à US-24

```json
{ "qrPayload": "TCKT.b4fe1185-….zQwj…", "deviceId": "android-kevin", "scannedAt": "2026-12-20T21:14:03Z", "clientScanId": "k-123" }
```

`scannedAt` et `clientScanId` sont optionnels en ligne.

| Résultat | Réponse `200` | Écran |
|---|---|---|
| `OK` | `{ "result": "OK", "ticketId", "holderName": "Aïcha K.", "category": "Standard", "scannedAt", "scannedCount": 1 }` | 🟢 vert, bip aigu, vibration |
| `DUPLICATE` | `{ "result": "DUPLICATE", "ticketId", "holderName", "category", "previousScanAt": "2026-10-07T08:34:19Z", "scannedAt", "scannedCount": 1 }` | 🔴 rouge « Déjà scanné à HH:MM », bip grave |
| `INVALID` | `{ "result": "INVALID", "scannedAt", "scannedCount": 2 }` | 🟠 orange « Ticket invalide » |

`INVALID` couvre : QR falsifié, ticket d'un autre événement, QR quelconque. `scannedCount` alimente le compteur en haut de l'écran. Deux agents qui scannent le même ticket au même instant : un seul obtient `OK`.

> ⚠️ **Toujours envoyer un `clientScanId` et réessayer avec le même en cas d'erreur.**
> Un scan peut être enregistré par le serveur alors que la réponse n'arrive pas (coupure réseau, erreur 5xx — constaté lors du test de charge). Si l'agent rescanne simplement, il verra 🔴 « Déjà scanné » alors que la personne n'est pas entrée.
>
> Logique à appliquer :
> 1. Générer `clientScanId = crypto.randomUUID()` **à la détection du QR**.
> 2. Pas de réponse, erreur réseau ou statut `5xx` → **renvoyer la même requête** (même `qrPayload`, même `clientScanId`), 2 ou 3 fois maximum.
> 3. Le serveur reconnaît le scan et renvoie le **résultat d'origine** avec `"replayed": true` (🟢 `OK` reste `OK`).
> 4. Toujours sans réponse → basculer en mode hors ligne : le scan rejoint la file `pendingScans` **avec le même `clientScanId`** (la synchro ne le comptera pas deux fois).
>
> ```js
> async function scanWithRetry(qrPayload) {
>   const clientScanId = crypto.randomUUID();
>   const body = JSON.stringify({ qrPayload, deviceId, scannedAt: new Date().toISOString(), clientScanId });
>   for (let attempt = 0; attempt < 3; attempt++) {
>     try {
>       const res = await fetch(`${API}/scan`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${staffToken}` }, body });
>       if (res.status < 500) return await res.json(); // 200, 401, 429… : réponse définitive
>     } catch { /* réseau coupé : on réessaie */ }
>     await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
>   }
>   return validateOffline(qrPayload, clientScanId); // file d'attente avec le même clientScanId
> }
> ```

#### `POST /scan/batch` 🛂 — US-25 (synchronisation hors ligne)

```json
{ "scans": [
  { "qrPayload": "TCKT.…", "deviceId": "android-kevin", "scannedAt": "2026-12-20T21:10:00Z", "clientScanId": "k-1" },
  { "qrPayload": "TCKT.…", "deviceId": "android-kevin", "scannedAt": "2026-12-20T21:11:00Z", "clientScanId": "k-2" }
] }
```

1 à 500 scans ; `scannedAt` et `clientScanId` **obligatoires**.

```json
200 {
  "results": [
    { "index": 0, "clientScanId": "k-1", "result": "DUPLICATE", "ticketId": "…", "holderName": "…", "category": "…", "previousScanAt": "…", "scannedAt": "…" },
    { "index": 1, "clientScanId": "k-2", "result": "OK", "ticketId": "…", "holderName": "…", "category": "…", "scannedAt": "…" }
  ],
  "summary": { "total": 2, "ok": 1, "duplicate": 1, "invalid": 0, "error": 0, "alreadySynced": 0 },
  "conflicts": [0],
  "scannedCount": 4,
  "syncedAt": "…"
}
```

`results[i].index` correspond à la position dans le lot envoyé. Voir le [guide](#7-guide--scanner-hors-ligne).

---

## 5. Codes d'erreur

| HTTP | `code` | Signification |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Donnée invalide (`field` = champ en cause) |
| 400 | `INVALID_JSON` | Corps JSON mal formé |
| 400 | `INVALID_BODY` | Upload non multipart |
| 400 | `INVALID_CURSOR` | Curseur de pagination invalide ou obtenu avec un autre tri : recharger sans curseur |
| 400 | `WEAK_PASSWORD` | Mot de passe refusé par Supabase Auth |
| 401 | `UNAUTHORIZED` | Jeton absent, invalide, expiré ou session fermée |
| 401 | `INVALID_CREDENTIALS` | Email/mot de passe ou code/PIN incorrects |
| 401 | `INVALID_REFRESH_TOKEN` | Session expirée : se reconnecter |
| 404 | `NOT_FOUND` | Ressource inconnue ou appartenant à un autre organisateur |
| 405 | `METHOD_NOT_ALLOWED` | Méthode non prévue sur cette route (voir l'en-tête `Allow`) |
| 409 | `EMAIL_TAKEN` | Compte déjà existant |
| 409 | `SOLD_OUT` | Plus assez de places |
| 409 | `EVENT_CLOSED` | Billetterie fermée |
| 409 | `EVENT_ENDED` | Événement terminé |
| 409 | `EVENT_NOT_PUBLISHED` | Événement en brouillon (connexion staff, clôture) |
| 409 | `EVENT_HAS_SALES` | Suppression impossible : tickets vendus |
| 409 | `QUANTITY_BELOW_SOLD` | Quantité inférieure aux tickets vendus |
| 409 | `CATEGORY_HAS_ORDERS` | Suppression d'une catégorie qui a des commandes |
| 409 | `ORDER_EXPIRED` | Commande non payée dans les 15 minutes |
| 409 | `CONFLICT` | Doublon en base |
| 413 | `FILE_TOO_LARGE` | Image > 5 Mo |
| 413 | `PAYLOAD_TOO_LARGE` | Corps JSON > 1 Mo |
| 415 | `UNSUPPORTED_FILE_TYPE` | Ni JPEG, ni PNG, ni WebP |
| 422 | `CATEGORY_NOT_FOUND` | Catégorie inconnue pour cet événement |
| 422 | `NO_CATEGORY` | Publication sans catégorie |
| 429 | `RATE_LIMITED` | Trop de requêtes (voir `Retry-After`) |
| 500 | `INTERNAL_ERROR` | Erreur serveur (jamais de détail technique exposé) |
| 502 | `UPLOAD_FAILED` | Échec d'enregistrement de l'image |

---

## 6. Limites de requêtes (rate limiting)

Par adresse IP et par minute. Au-delà : `429 RATE_LIMITED` + en-tête `Retry-After` (secondes avant la prochaine fenêtre).

| Routes | Limite |
|---|---|
| `POST /auth/signup`, `/auth/login`, `/auth/refresh` (compteur commun) | 10 / min |
| `POST /staff/login` | 10 / min |
| `POST /orders` | 60 / min |
| `POST /orders/:id/simulate-payment` | 120 / min |
| `POST` / `DELETE /public/events/:slug/like` (compteur commun) | 60 / min |
| `POST /scan` | 100 / min **par agent** (session staff) |
| `POST /scan/batch` | 30 / min **par agent** (session staff) |

Le scan est compté **par agent connecté** et non par IP : les agents d'un même lieu partagent souvent la même IP publique (wifi du club). Les routes de lecture (page publique, dashboard, stats) ne sont pas limitées.

---

## 7. Guide : scanner hors ligne

### Principe

À la connexion, le scanner reçoit `ticketHashes` : l'empreinte **SHA-256 (hex minuscule)** du `qrPayload` de chaque ticket de l'événement (non annulé, déjà scanné ou non). `tickets` donne, pour chaque empreinte, le nom, la catégorie, le `status` (`VALID` ou `SCANNED`) et `scannedAt`. Hors ligne, un QR est reconnu si son empreinte figure dans cette liste. Le secret de signature ne quitte jamais le serveur.

### Calculer l'empreinte d'un QR dans le navigateur

```js
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// sha256Hex(qrPayload) === "c8c6c83ba06aa2619f8db7fed4705d0ed41cfc2970bc7482fe46c75d531fbfae"
```

> `crypto.subtle` exige HTTPS (ou `localhost`).

### Logique conseillée

1. **Connexion** → stocker `token`, `tickets` (indexés par `hash`) et `scannedCount` dans IndexedDB.
2. **Scan en ligne** → `POST /scan` avec un `clientScanId`, réessayé à l'identique en cas d'erreur (voir [§4.9](#49-scan)). Toujours en échec → mode hors ligne, avec le même `clientScanId`.
3. **Scan hors ligne** :
   - empreinte inconnue → 🟠 `INVALID` ;
   - ticket déjà marqué scanné localement → 🔴 `DUPLICATE` (avec l'heure locale) ;
   - sinon → 🟢 `OK`, marquer le ticket scanné localement, ajouter à la file `pendingScans` :
     `{ qrPayload, deviceId, scannedAt: new Date().toISOString(), clientScanId: crypto.randomUUID() }`.
4. **Retour du réseau** (`online`) → `POST /scan/batch` avec la file (par lots de 500 max).
   - Réponse reçue → vider les scans envoyés, toast « N scans synchronisés » (`summary.ok`).
   - Pas de réponse (coupure) → **renvoyer le même lot tel quel** : grâce à `clientScanId`, rien n'est compté deux fois (`summary.alreadySynced`).
   - `conflicts` non vide → ticket déjà entré via un autre appareil (signaler, éventuelle fraude).
5. **Toutes les 2 à 5 minutes en ligne** → `GET /staff/tickets` pour récupérer les tickets vendus depuis la connexion et les scans des autres agents.
6. **`401`** → session révoquée (code régénéré) : retour à l'écran code + PIN.

### Règle des conflits

Dans un lot, les scans sont traités par `scannedAt` croissant. Entre appareils, **le premier qui synchronise** obtient `OK` ; les autres reçoivent `DUPLICATE` et apparaissent dans `conflicts`.

---

## 8. Écarts avec le PRD v1.0

| PRD | Implémentation | Raison |
|---|---|---|
| Next.js API routes + Prisma + Neon | Supabase : Postgres, Auth, Storage, Edge Function `api` | Déploiement sur Supabase |
| Session par cookie HTTPOnly | Jeton `Authorization: Bearer` | Front (Vercel) et API (Supabase) sur deux domaines ; pas de cookie tiers, pas de CSRF |
| IDs `cuid()` | UUID v4 | Natif Postgres |
| — | `POST /auth/refresh` | Renouvellement du jeton (1 h) |
| — | `DELETE /events/:id`, `POST /events/:id/close` | Livrable Phase 1 (suppression) ; statut `CLOSED` sans route dans le PRD |
| uploadthing | `POST /uploads/cover` (Supabase Storage) | Pas de dépendance externe |
| — | `GET /staff/tickets` | Index hors ligne à jour après la connexion |
| `ticketHashes: [...]` | + `tickets` (nom, catégorie, statut par empreinte) | Afficher nom et catégorie hors ligne (US-21) |
| SECRET partagé au staff pour valider hors ligne (§6.7) | Seules les empreintes des QR sont partagées | Le secret ne quitte jamais le serveur : un appareil perdu ne permet pas de fabriquer des tickets |
| Rate limit 10/min sur `/api/orders` | 60/min (+ 120/min paiement) | IP partagées par les opérateurs mobiles (CGNAT) |
| Rate limit sur `/api/auth/*` | Sauf `/auth/me` et `/auth/logout` | `/me` est appelé à chaque page |
| Rate limit `/api/scan` 100/min par IP | 100/min **par agent** | Plusieurs agents sur le même wifi partagent une IP |

### Ajouts du PRD v2 (§7 et §8 transmis par Jude)

| Demande | Implémentation | Choix faits sans le document v2 (à confirmer) |
|---|---|---|
| `GET /public/events?q=&category=&sort=popular\|date&cursor=&country=` | Implémenté, + `limit` et `deviceId` | `popular` = nombre de likes ; seuls les événements non terminés sont listés |
| `category` sur les événements | 6 valeurs, défaut `SOIREE` | Optionnel à la création (compatibilité) |
| Likes : `likesCount`, `POST`/`DELETE /public/events/:slug/like` | Implémenté, un like par `deviceId` | + `isLiked` avec `?deviceId=` |
| `country`, `timeZone`, `coverFit`, `description` des catégories | Implémentés | ISO 2 lettres, fuseau IANA, `cover`\|`contain`, 300 caractères |
| Compte acheteur (`/buyer/...`) | En cours | Code de connexion par e-mail |
