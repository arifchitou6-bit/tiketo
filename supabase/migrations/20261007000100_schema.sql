-- TICKETO — schéma initial (PRD §5, adapté à Supabase)
-- Conventions : snake_case en base, camelCase dans l'API ; dates en timestamptz (UTC) ; montants en FCFA entiers.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.event_status  as enum ('DRAFT', 'PUBLISHED', 'CLOSED');
create type public.order_status  as enum ('PENDING', 'PAID', 'FAILED');
create type public.ticket_status as enum ('VALID', 'SCANNED', 'INVALIDATED');
create type public.scan_result   as enum ('OK', 'DUPLICATE', 'INVALID');

-- ---------------------------------------------------------------------------
-- Organisateurs (1-1 avec auth.users ; le mot de passe est géré par Supabase Auth)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  name       text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Événements
-- ---------------------------------------------------------------------------
create table public.events (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name            text not null check (char_length(name) between 2 and 140),
  description     text not null default '' check (char_length(description) <= 10000),
  cover_image_url text,
  venue           text not null check (char_length(venue) between 1 and 160),
  city            text not null check (char_length(city) between 1 and 80),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          public.event_status not null default 'DRAFT',
  organizer_id    uuid not null references public.profiles (id) on delete cascade,
  staff_code      text unique check (staff_code ~ '^[A-Z0-9]{6}$'),
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint events_dates_chk check (ends_at > starts_at)
);
create index events_organizer_idx on public.events (organizer_id, starts_at desc);

-- Secrets d'un événement : table séparée, sans aucune politique RLS
-- => accessible uniquement par le service_role (Edge Function) et les fonctions SECURITY DEFINER.
create table public.event_secrets (
  event_id       uuid primary key references public.events (id) on delete cascade,
  qr_secret      text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  staff_pin_hash text
);

-- ---------------------------------------------------------------------------
-- Catégories de tickets
-- ---------------------------------------------------------------------------
create table public.ticket_categories (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  price_fcfa integer not null check (price_fcfa between 0 and 10000000),
  quantity   integer not null check (quantity between 1 and 100000),
  sold       integer not null default 0,
  position   smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint ticket_categories_sold_chk check (sold >= 0 and sold <= quantity)
);
create index ticket_categories_event_idx on public.ticket_categories (event_id, position);

-- ---------------------------------------------------------------------------
-- Commandes
-- ---------------------------------------------------------------------------
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events (id) on delete cascade,
  buyer_name        text not null check (char_length(buyer_name) between 2 and 120),
  buyer_phone       text not null check (buyer_phone ~ '^\+?[0-9]{8,15}$'),
  buyer_email       text,
  total_amount      integer not null check (total_amount >= 0),
  payment_provider  text not null check (payment_provider in ('mtn', 'moov', 'celtiis')),
  payment_reference text not null unique,
  status            public.order_status not null default 'PENDING',
  failure_reason    text,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
create index orders_event_created_idx on public.orders (event_id, created_at desc);
create index orders_pending_idx on public.orders (created_at) where status = 'PENDING';

-- Lignes de commande (nécessaires pour générer les tickets au paiement)
create table public.order_items (
  order_id        uuid not null references public.orders (id) on delete cascade,
  category_id     uuid not null references public.ticket_categories (id),
  quantity        integer not null check (quantity between 1 and 20),
  unit_price_fcfa integer not null check (unit_price_fcfa >= 0),
  primary key (order_id, category_id)
);
create index order_items_category_idx on public.order_items (category_id);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------
create table public.tickets (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders (id) on delete cascade,
  category_id uuid not null references public.ticket_categories (id),
  event_id    uuid not null references public.events (id) on delete cascade,
  holder_name text not null,
  qr_payload  text not null unique,
  qr_hash     text not null unique, -- sha256(qr_payload) en hex : index de validation hors ligne
  status      public.ticket_status not null default 'VALID',
  scanned_at  timestamptz,
  scan_count  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index tickets_order_idx on public.tickets (order_id);
create index tickets_event_idx on public.tickets (event_id, status);
create index tickets_category_idx on public.tickets (category_id);

-- ---------------------------------------------------------------------------
-- Journal des scans
-- ---------------------------------------------------------------------------
create table public.scan_events (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid references public.tickets (id) on delete cascade, -- null si QR inconnu / falsifié
  event_id    uuid not null references public.events (id) on delete cascade,
  staff_code  text not null,
  device_id   text not null,
  scanned_at  timestamptz not null default now(),
  synced_at   timestamptz,
  result      public.scan_result not null,
  client_scan_id text, -- idempotence de la synchro hors ligne
  constraint scan_events_client_uniq unique (device_id, client_scan_id)
);
create index scan_events_event_idx on public.scan_events (event_id, scanned_at);
create index scan_events_ticket_idx on public.scan_events (ticket_id);

-- ---------------------------------------------------------------------------
-- Sessions staff (token opaque ; seul son sha256 est stocké)
-- ---------------------------------------------------------------------------
create table public.staff_sessions (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  staff_code text not null,
  token_hash text not null unique,
  device_id  text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index staff_sessions_event_idx on public.staff_sessions (event_id);

-- ---------------------------------------------------------------------------
-- Rate limiting (fenêtre fixe)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger events_set_updated_at
before update on public.events
for each row execute function public.tg_set_updated_at();

-- Chaque événement reçoit automatiquement son secret HMAC.
create or replace function public.tg_create_event_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.event_secrets (event_id) values (new.id);
  return new;
end;
$$;

create trigger events_create_secret
after insert on public.events
for each row execute function public.tg_create_event_secret();

-- Création du profil organisateur à l'inscription Supabase Auth.
create or replace function public.tg_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.tg_handle_new_user();
