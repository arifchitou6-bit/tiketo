-- TICKETO — PRD v2.1 §7 et §8.4 : compte acheteur, connexion par numéro de téléphone et code à 6 chiffres
-- Démo : aucun SMS, le code est renvoyé à l'écran (devCode, désactivable côté API).
-- Comptes séparés des organisateurs (Supabase Auth) : un acheteur n'a jamais accès à l'espace organisateur,
-- et l'inscription publique de Supabase Auth reste désactivée.
-- Seules les empreintes (sha256) des codes et des jetons de session sont stockées.

create table public.buyers (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique check (phone ~ '^\+?[0-9]{8,15}$'),   -- ex. +2290197001234
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

-- Un code actif au plus par numéro ; remplacé à chaque nouvelle demande
create table public.buyer_otps (
  phone      text primary key,
  code_hash  text not null,                 -- sha256("<numéro>:<code>")
  attempts   integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Session au même format que l'organisateur : jeton d'accès court + jeton de renouvellement (rotation)
create table public.buyer_sessions (
  id                 uuid primary key default gen_random_uuid(),
  buyer_id           uuid not null references public.buyers (id) on delete cascade,
  token_hash         text not null unique,     -- jeton d'accès
  expires_at         timestamptz not null,
  refresh_hash       text not null unique,     -- jeton de renouvellement
  refresh_expires_at timestamptz not null,
  device_id          text,
  created_at         timestamptz not null default now(),
  revoked_at         timestamptz
);
create index buyer_sessions_buyer_idx on public.buyer_sessions (buyer_id);

alter table public.buyers enable row level security;          -- aucune politique : accès par l'API uniquement
alter table public.buyer_otps enable row level security;
alter table public.buyer_sessions enable row level security;

-- Commandes d'un acheteur retrouvées par Order.buyerPhone = Buyer.phone (pas de clé étrangère, PRD §7)
create index orders_buyer_phone_idx on public.orders (buyer_phone, paid_at desc) where status = 'PAID';

-- Likes faits en étant connecté = favoris du compte
alter table public.event_likes add column buyer_id uuid references public.buyers (id) on delete set null;
create index event_likes_buyer_idx on public.event_likes (buyer_id) where buyer_id is not null;

-- ---------------------------------------------------------------------------
-- Demande de code : délai minimal entre deux envois pour un même numéro
-- Renvoie { ok: true } ou { ok: false, retryAfter: secondes }
-- ---------------------------------------------------------------------------
create or replace function public.buyer_otp_store(p_phone text, p_code_hash text, p_ttl_seconds integer,
                                                  p_cooldown_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_last timestamptz;
begin
  select created_at into v_last from public.buyer_otps where phone = p_phone for update;
  if v_last is not null and v_last > now() - make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object('ok', false,
      'retryAfter', ceil(extract(epoch from (v_last + make_interval(secs => p_cooldown_seconds) - now())))::integer);
  end if;

  insert into public.buyer_otps (phone, code_hash, attempts, created_at, expires_at)
  values (p_phone, p_code_hash, 0, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (phone) do update
    set code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Vérification du code et ouverture de session
-- Ne lève pas d'exception sur un mauvais code : le compteur d'essais doit être enregistré.
-- Renvoie { ok: true, buyerId, expiresAt, refreshExpiresAt } ou { ok: false, reason, attemptsLeft? }
-- ---------------------------------------------------------------------------
create or replace function public.buyer_otp_verify(p_phone text, p_code_hash text, p_token_hash text, p_refresh_hash text,
                                                   p_access_seconds integer, p_refresh_days integer, p_device_id text,
                                                   p_max_attempts integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_otp public.buyer_otps;
  v_buyer_id uuid;
  v_expires timestamptz := now() + make_interval(secs => p_access_seconds);
  v_refresh_expires timestamptz := now() + make_interval(days => p_refresh_days);
begin
  select * into v_otp from public.buyer_otps where phone = p_phone for update;
  if v_otp.phone is null then
    return jsonb_build_object('ok', false, 'reason', 'OTP_INVALID', 'attemptsLeft', 0);
  end if;
  if v_otp.expires_at <= now() then
    delete from public.buyer_otps where phone = p_phone;
    return jsonb_build_object('ok', false, 'reason', 'OTP_EXPIRED');
  end if;
  if v_otp.attempts >= p_max_attempts then
    return jsonb_build_object('ok', false, 'reason', 'OTP_TOO_MANY_ATTEMPTS');
  end if;
  if v_otp.code_hash <> p_code_hash then
    update public.buyer_otps set attempts = attempts + 1 where phone = p_phone;
    return jsonb_build_object('ok', false, 'reason',
      case when v_otp.attempts + 1 >= p_max_attempts then 'OTP_TOO_MANY_ATTEMPTS' else 'OTP_INVALID' end,
      'attemptsLeft', p_max_attempts - v_otp.attempts - 1);
  end if;
  delete from public.buyer_otps where phone = p_phone; -- code à usage unique

  insert into public.buyers (phone) values (p_phone)
  on conflict (phone) do update set last_login_at = now()
  returning id into v_buyer_id;

  insert into public.buyer_sessions (buyer_id, token_hash, expires_at, refresh_hash, refresh_expires_at, device_id)
  values (v_buyer_id, p_token_hash, v_expires, p_refresh_hash, v_refresh_expires, p_device_id);

  -- Les likes faits sur cet appareil avant la connexion rejoignent les favoris du compte
  if p_device_id is not null then
    update public.event_likes set buyer_id = v_buyer_id where device_id = p_device_id and buyer_id is null;
  end if;

  return jsonb_build_object('ok', true, 'buyerId', v_buyer_id, 'expiresAt', v_expires, 'refreshExpiresAt', v_refresh_expires);
end;
$$;

-- ---------------------------------------------------------------------------
-- Renouvellement (POST /auth/refresh avec un jeton acheteur) : rotation des deux jetons
-- Renvoie { ok: true, buyerId, expiresAt } ou { ok: false }
-- ---------------------------------------------------------------------------
create or replace function public.buyer_refresh(p_refresh_hash text, p_token_hash text, p_new_refresh_hash text,
                                                p_access_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.buyer_sessions;
  v_expires timestamptz := now() + make_interval(secs => p_access_seconds);
begin
  select * into v_session from public.buyer_sessions
  where refresh_hash = p_refresh_hash and revoked_at is null and refresh_expires_at > now()
  for update;
  if v_session.id is null then
    return jsonb_build_object('ok', false);
  end if;

  update public.buyer_sessions
  set token_hash = p_token_hash, expires_at = v_expires, refresh_hash = p_new_refresh_hash
  where id = v_session.id;
  return jsonb_build_object('ok', true, 'buyerId', v_session.buyer_id, 'expiresAt', v_expires);
end;
$$;

-- ---------------------------------------------------------------------------
-- Favoris : événements publiés ou clos likés par le compte (le plus récent d'abord)
-- ---------------------------------------------------------------------------
create or replace function public.buyer_favorites(p_buyer_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x."likedAt" desc), '[]'::jsonb)
  from (
    select
      e.id, e.slug, e.name, e.category,
      e.cover_image_url as "coverImageUrl", e.cover_fit as "coverFit",
      e.venue, e.city, e.country, e.time_zone as "timeZone",
      e.starts_at as "startsAt", e.ends_at as "endsAt", e.status,
      e.likes_count as "likesCount",
      coalesce(c.min_available, c.min_all) as "minPriceFcfa",
      coalesce(c.sold_out, false) as "isSoldOut",
      e.ends_at <= now() as "isPast",
      (e.status = 'PUBLISHED' and e.ends_at > now() and not coalesce(c.sold_out, false)) as "isSalesOpen",
      true as "isLiked",
      l.liked_at as "likedAt"
    from (
      select event_id, max(created_at) as liked_at
      from public.event_likes where buyer_id = p_buyer_id group by event_id
    ) l
    join public.events e on e.id = l.event_id and e.status in ('PUBLISHED', 'CLOSED')
    left join lateral (
      select min(price_fcfa) filter (where sold < quantity) as min_available,
             min(price_fcfa) as min_all,
             bool_and(sold >= quantity) as sold_out
      from public.ticket_categories where event_id = e.id
    ) c on true
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- Like / unlike : rattaché au compte si l'acheteur est connecté
-- ---------------------------------------------------------------------------
drop function public.set_event_like(text, text, boolean);

create or replace function public.set_event_like(p_slug text, p_device_id text, p_liked boolean, p_buyer_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event_id uuid;
  v_count integer;
begin
  select id into v_event_id from public.events where slug = p_slug and status in ('PUBLISHED', 'CLOSED');
  if v_event_id is null then
    raise exception 'NOT_FOUND' using detail = 'Événement introuvable';
  end if;

  if p_liked then
    insert into public.event_likes (event_id, device_id, buyer_id) values (v_event_id, p_device_id, p_buyer_id)
    on conflict (event_id, device_id) do update set buyer_id = coalesce(excluded.buyer_id, public.event_likes.buyer_id);
  else
    -- Connecté : retire aussi le favori enregistré depuis un autre appareil
    delete from public.event_likes
    where event_id = v_event_id and (device_id = p_device_id or (p_buyer_id is not null and buyer_id = p_buyer_id));
  end if;

  select likes_count into v_count from public.events where id = v_event_id;
  return jsonb_build_object('liked', p_liked, 'likesCount', v_count);
end;
$$;

revoke all on function public.buyer_otp_store(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.buyer_otp_verify(text, text, text, text, integer, integer, text, integer) from public, anon, authenticated;
revoke all on function public.buyer_refresh(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.buyer_favorites(uuid) from public, anon, authenticated;
revoke all on function public.set_event_like(text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.buyer_otp_store(text, text, integer, integer) to service_role;
grant execute on function public.buyer_otp_verify(text, text, text, text, integer, integer, text, integer) to service_role;
grant execute on function public.buyer_refresh(text, text, text, integer) to service_role;
grant execute on function public.buyer_favorites(uuid) to service_role;
grant execute on function public.set_event_like(text, text, boolean, uuid) to service_role;

-- Ménage horaire : codes expirés et sessions acheteur périmées
select cron.schedule(
  'ticketo-cleanup',
  '17 * * * *',
  $$
    delete from public.rate_limits where window_start < now() - interval '1 hour';
    delete from public.staff_sessions where expires_at < now() - interval '7 days';
    delete from public.buyer_otps where expires_at < now() - interval '1 hour';
    delete from public.buyer_sessions where refresh_expires_at < now() or revoked_at < now() - interval '7 days';
  $$
);

-- Photo de la démo : la nouvelle colonne (buyer_id) des likes déjà photographiés
update demo.snapshot set rows = (
  select coalesce(jsonb_agg(jsonb_build_object('buyer_id', null) || r), '[]') from jsonb_array_elements(rows) r)
where table_name = 'event_likes';
