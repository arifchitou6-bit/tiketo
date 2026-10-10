# TICKETO — Décisions techniques (backend)

Chaque décision suit le format **Contexte → Décision → Conséquences**. Les écarts avec le PRD v1.0 y sont justifiés.

---

## D1. Supabase plutôt que Next.js API + Prisma + Neon

**Contexte.** Le PRD prévoyait des routes API Next.js, Prisma et Neon, déployés sur Vercel. Le backend doit être déployé sur Supabase.

**Décision.** Postgres, Auth, Storage et pg_cron de Supabase ; migrations SQL versionnées ; une Edge Function `api` pour toutes les routes.

**Conséquences.** Une seule plateforme pour toute la partie serveur. Le contrat d'API du PRD est conservé (mêmes routes sous `/functions/v1/api`). Les IDs sont des UUID au lieu de `cuid()`.

## D2. Une seule Edge Function (Hono) plutôt qu'une fonction par route

**Contexte.** Supabase facture et démarre chaque fonction séparément ; le PRD décrit une API REST cohérente.

**Décision.** Une fonction `api` avec le routeur Hono, validation Zod, middlewares communs (CORS, auth, rate limiting, format d'erreur, journal).

**Conséquences.** Un seul déploiement, un seul démarrage à froid, code partagé simple. La fonction est déployée avec `--no-verify-jwt` : l'authentification est vérifiée dans le code (organisateur et staff n'utilisent pas le même type de jeton).

## D3. Jeton `Authorization: Bearer` plutôt que cookie de session

**Contexte.** Le PRD prévoyait un cookie HTTPOnly. Le front (Vercel) et l'API (supabase.co) sont sur deux domaines : un cookie tiers serait bloqué par de nombreux navigateurs et imposerait une protection CSRF.

**Décision.** Jetons Supabase Auth (1 h) renvoyés par `/auth/login`, envoyés dans l'en-tête `Authorization`, renouvelés par `/auth/refresh` (route ajoutée).

**Conséquences.** Pas de CSRF possible (aucun cookie). Le front stocke la session et gère le renouvellement.

## D4. Vérification locale du jeton + contrôle de session

**Contexte.** Vérifier le jeton auprès du service Auth à chaque requête coûtait 300 à 1 300 ms (mesuré), inacceptable pour le polling du dashboard toutes les 10 s.

**Décision.** `getClaims()` vérifie la signature ES256 localement (clé publique JWKS en cache) ; une requête SQL (`is_session_active`) vérifie que la session n'a pas été fermée.

**Conséquences.** ≈ 55 ms par requête authentifiée ; la déconnexion reste immédiate. Nécessite des clés de signature asymétriques sur le projet (sinon `getClaims()` repasse automatiquement par le service Auth).

## D5. Logique critique dans des fonctions PL/pgSQL transactionnelles

**Contexte.** L'API Supabase (PostgREST) n'offre pas de transaction sur plusieurs requêtes. Créer une commande, payer ou scanner touche plusieurs tables à la fois.

**Décision.** `create_event`, `update_event`, `create_order`, `pay_order`, `scan_ticket`, `scan_batch`, `event_stats`… sont des fonctions SQL `SECURITY DEFINER`, exécutables uniquement par l'API (service_role). Erreurs métier levées sous forme de codes (`SOLD_OUT`, `EVENT_CLOSED`…) traduits par l'API au format `{ error: { code, message, field } }`.

**Conséquences.** Chaque opération est atomique ; aucune donnée à moitié écrite. Les statistiques tiennent en une requête (pas de N+1).

## D6. Places attribuées au paiement, pas à la commande

**Contexte.** Le PRD demande « vérifier les quotas » à la commande et « incrémenter `sold` de façon transactionnelle » au paiement.

**Décision.** La commande vérifie la disponibilité sans réserver. Le paiement verrouille les catégories (`FOR UPDATE`, ordre stable), revérifie les quotas puis attribue les places. Le paiement est idempotent.

**Conséquences.** Survente impossible (testé avec deux paiements simultanés sur les dernières places). Un panier abandonné ne bloque aucune place. Si deux acheteurs visent la dernière place, le premier qui paie l'obtient ; le second reçoit `SOLD_OUT`.

## D7. QR signés HMAC avec un secret par événement, stocké à part

**Contexte.** PRD §6.7 : `TCKT.{ticketId}.{HMAC_SHA256(ticketId, SECRET)}`, secret par événement.

**Décision.** Secret aléatoire de 256 bits généré par trigger à la création de l'événement, stocké dans `event_secrets` (RLS sans aucune politique : invisible hors API). Signature en base64url.

**Conséquences.** Un QR ne peut pas être fabriqué ni modifié sans le secret (vérifié par un test qui recalcule les signatures).

## D8. Mode hors ligne par empreintes, sans partager le secret

**Contexte.** Le PRD proposait de partager le SECRET de l'événement avec le scanner pour valider hors ligne.

**Décision.** Le scanner reçoit uniquement l'empreinte SHA-256 de chaque QR vendu (`ticketHashes`) et les infos d'affichage. Un QR est valide hors ligne si son empreinte est connue. `GET /staff/tickets` rafraîchit l'index.

**Conséquences.** Un téléphone perdu ou inspecté ne permet pas de fabriquer de faux tickets. Contrepartie : un ticket acheté après le dernier rafraîchissement n'est pas reconnu hors ligne.

## D9. Scans idempotents (`clientScanId`) et règle de conflit

**Contexte.** Réseau instable dans les clubs ; le test de charge a montré qu'un scan peut être enregistré alors que la réponse est perdue.

**Décision.** Chaque scan peut porter un `clientScanId` unique par appareil (contrainte unique en base). Un même scan renvoyé retourne son résultat d'origine (`replayed: true`). Un lot hors ligne est traité par ordre chronologique ; entre appareils, le premier synchronisé gagne, les autres sont `DUPLICATE` et listés dans `conflicts`.

**Conséquences.** Aucun double comptage, même en renvoyant un lot entier. L'agent ne voit pas « déjà scanné » sur un ticket qu'il vient de valider.

## D10. Rate limiting dans Postgres (sans Redis)

**Contexte.** PRD §9 : 10 requêtes/min par IP sur l'auth, les commandes et le scan. Le plan interdit Redis et les workers.

**Décision.** Compteur à fenêtre fixe dans la table `rate_limits`. IP lue sur le **dernier** élément de `X-Forwarded-For` (le premier peut être forgé : contournement constaté puis corrigé). Limites retenues :

| Route | Limite | Écart PRD |
|---|---|---|
| auth (signup, login, refresh) | 10/min/IP | `/me` et `/logout` exclus (appelés à chaque page) |
| staff/login | 10/min/IP | protège le PIN à 4 chiffres |
| orders | 60/min/IP | relevé : les opérateurs mobiles partagent une IP entre de nombreux abonnés (CGNAT) |
| simulate-payment | 120/min/IP | idem |
| scan | 100/min **par agent** | les agents d'un club partagent le même wifi, donc la même IP |
| scan/batch | 30/min par agent | |

**Conséquences.** Aucune dépendance supplémentaire. Si le compteur est indisponible, la requête passe (on ne bloque pas tout le monde).

## D11. Expiration des commandes : pg_cron + vérification paresseuse

**Contexte.** PRD §7 : une commande PENDING de plus de 15 min passe en FAILED.

**Décision.** Tâche pg_cron toutes les 5 min, plus vérification au moment de la lecture (`GET /orders/:id`) et du paiement.

**Conséquences.** L'acheteur voit « commande expirée » immédiatement ; les compteurs du dashboard restent justes même pour les paniers que personne ne rouvre.

## D12. Écriture en base uniquement via l'API

**Contexte.** L'audit a montré qu'un organisateur pouvait, avec son jeton, modifier directement ses catégories par l'API REST de Supabase (remettre `sold` à 0 → survente possible).

**Décision.** Aucun droit d'écriture directe pour `anon` et `authenticated` ; la RLS ne sert plus qu'à la lecture (utile pour d'éventuels abonnements temps réel côté front). Inscription publique de Supabase Auth désactivée : les comptes sont créés par `/api/auth/signup`.

**Conséquences.** Toutes les règles métier sont incontournables.

## D13. Paiement Mobile Money simulé

**Contexte.** Hors périmètre (cahier des charges §5.2) ; « interdiction absolue » de tenter une vraie intégration.

**Décision.** `POST /orders/:id/simulate-payment`, appelé par l'écran de paiement après 3 s, exécute exactement le chemin d'un paiement confirmé.

**Conséquences.** Remplacer la simulation par un webhook d'agrégateur (FedaPay, KkiaPay…) ne demandera qu'un nouvel appel à `pay_order`.

## D14. Commandes et tickets accessibles par lien

**Contexte.** PRD : `GET /api/orders/:id` « accessible sans auth via lien direct », pour l'envoi WhatsApp.

**Décision.** Conservé. Les identifiants sont des UUID v4 aléatoires (non devinables).

**Conséquences.** Quiconque possède le lien voit la commande (nom, téléphone de l'acheteur, tickets). Acceptable pour la démo ; en production, un jeton de partage dédié et des QR à durée limitée seraient préférables.

## D15. Page publique en cache 30 s

**Contexte.** PRD : « revalidate 30 s » ; un lien partagé sur Instagram peut provoquer un pic de visites.

**Décision.** En-tête `Cache-Control: public, max-age=30` + cache mémoire dans l'Edge Function.

**Conséquences.** Les places restantes affichées peuvent avoir 30 s de retard ; aucun risque, les quotas réels sont revérifiés à la commande et au paiement.

## D16. Code staff 6 caractères + PIN 4 chiffres

**Décision.** Code sans caractères ambigus (0/O, 1/I/L), PIN haché en bcrypt, affiché une seule fois ; régénérer révoque immédiatement les sessions existantes. Session staff : jeton opaque de 256 bits (seule l'empreinte est stockée), valable jusqu'à 12 h après la fin de l'événement.

**Conséquences.** 10 000 PIN possibles, mais il faut aussi le code et la limite est de 10 essais/min : confort de saisie à la porte avec un risque maîtrisé.

## D17. Supabase Storage plutôt qu'uploadthing

**Décision.** Bucket public `event-covers` (JPEG/PNG/WebP, 5 Mo), un dossier par organisateur, type vérifié sur le contenu réel du fichier.

**Conséquences.** Pas de service externe. Un envoi trop gros est rejeté sans décoder le fichier (sinon l'Edge Function dépasse sa limite CPU).

## D18. Tests d'intégration contre l'API réelle

**Décision.** `node:test` sans framework ; chaque fichier crée et supprime ses propres comptes ; même suite exécutable contre la production (`API_URL`, `DATABASE_URL`).

**Conséquences.** Les garanties (pas de survente, pas de double entrée, isolation entre organisateurs, résistance aux contournements) sont vérifiées de bout en bout.

## D19. Remise à zéro de la démo par photo + restauration

**Contexte.** Les accès démo sont publics (README, bouton de connexion en un clic du front). N'importe qui peut supprimer un événement ou régénérer le code staff, ce qui rendrait faux les accès publiés. Relancer le seed ne convient pas : il crée de nouveaux slugs, codes et QR.

**Décision.** `demo_snapshot()` enregistre toutes les lignes du compte de démo (JSON, schéma privé `demo`) ; `demo_reset()`, lancé par pg_cron chaque nuit à 3 h (Cotonou), supprime tout ce que possède le compte et recharge la photo avec les mêmes identifiants et secrets. Les dates sont décalées du nombre minimal de semaines entières pour que le premier événement commence dans plus de 24 h.

**Conséquences.** Les liens, codes staff, PIN et QR publiés restent valables indéfiniment ; la démo reste « à venir » et le jour de la semaine est conservé. Les commandes passées par des visiteurs sur la démo disparaissent chaque nuit. Après une migration qui ajoute des colonnes, il faut reprendre la photo. Les images envoyées par des visiteurs dans Storage ne sont pas supprimées (pas de suppression SQL possible dans Storage).

## D20. Liste publique : curseur keyset, recherche sans accents, likes par appareil

**Contexte.** PRD v2 : accueil et recherche (`q`, `category`, `country`, `sort=popular|date`, `cursor`) et likes avec `deviceId`, sans compte.

**Décision.** Une fonction SQL (`list_public_events`) filtre, trie et pagine en une requête. Le curseur est un jeton opaque contenant la clé de tri de la dernière ligne (date, id, likes) : pagination *keyset*, stable quand des événements sont publiés entre deux pages, et liée au tri choisi. La recherche normalise les accents (`unaccent`) et exige chaque mot. Les likes sont uniques par (événement, appareil) ; le compteur `likes_count` est tenu par un trigger pour trier par popularité sans recompter.

**Conséquences.** Les likes sont anonymes : un utilisateur peut liker depuis plusieurs appareils, et un script peut gonfler un compteur en inventant des `deviceId` (limité à 60 requêtes/min par IP). Acceptable pour un indicateur de popularité ; en production, lier les likes au compte acheteur. La recherche par `position` n'utilise pas d'index : suffisant jusqu'à quelques milliers d'événements (au-delà : `pg_trgm`).

## D21. Détail public : cache pour les anonymes, lecture directe avec `deviceId`

**Contexte.** Les tests croisés ont montré qu'après un like, le détail public pouvait afficher `isLiked: true` avec `likesCount: 0` (cache de 30 s, D15), et des places restantes en retard après un achat.

**Décision.** Sans `deviceId`, le détail reste servi depuis le cache de 30 s (pics de visites). Avec `deviceId`, la réponse est déjà propre à l'appareil et non mise en cache : elle est lue en direct. Un like vide aussi le cache de l'événement sur l'instance.

**Conséquences.** Un front qui envoie toujours `deviceId` affiche des chiffres cohérents avec le reste de l'API, pour une requête de plus par affichage. Les visiteurs anonymes gardent jusqu'à 30 s de retard (sans risque : les quotas sont revérifiés à la commande).

## D22. Compte acheteur par numéro et code, séparé de Supabase Auth

**Contexte.** PRD v2.1 §8.4 : connexion facultative par numéro de téléphone et code à 6 chiffres, sans SMS réel en démo (code renvoyé dans `devCode`), session au même format que l'organisateur et renouvelable par `/auth/refresh`. L'inscription publique de Supabase Auth est désactivée (D12) et ses comptes sont ceux des organisateurs.

**Décision.** Tables propres (`buyers`, `buyer_otps`, `buyer_sessions`) : code de 10 minutes, 5 essais, 60 s entre deux codes, 5 codes par heure et par numéro ; jeton d'accès opaque d'une heure et jeton de renouvellement de 30 jours, avec rotation ; seules les empreintes sont stockées. `/auth/refresh` reconnaît les jetons acheteur (64 caractères hexadécimaux) et renvoie la même forme de session. Les commandes sont retrouvées par le numéro (PRD : pas de clé étrangère), le nom par la dernière commande payée ; les favoris sont les likes faits en étant connecté. `devCode` est activé par défaut et se coupe avec `BUYER_OTP_DEV_CODE=off`. Un code bloqué après 5 erreurs renvoie `OTP_EXPIRED` (codes d'erreur du PRD uniquement).

**Conséquences.** Un acheteur n'accède jamais aux espaces organisateur ou scanner. En démo, n'importe qui peut se connecter avec n'importe quel numéro et voir les commandes payées avec ce numéro : acceptable avec des données fictives, mais un vrai envoi de SMS est indispensable en production (roadmap). Le module d'envoi d'e-mails Brevo (`lib/email.ts`, clé configurée et testée) est conservé en réserve, non branché.
