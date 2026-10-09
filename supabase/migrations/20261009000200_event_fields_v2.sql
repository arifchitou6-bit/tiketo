-- TICKETO — PRD v2 : nouveaux champs des événements et des catégories, likes
-- Champs facultatifs à la création (valeurs par défaut) : les clients existants continuent de fonctionner.

create type public.event_category as enum ('CONCERT', 'SOIREE', 'FESTIVAL', 'CONFERENCE', 'THEATRE', 'EXPOSITION');

alter table public.events
  add column category    public.event_category not null default 'SOIREE',
  add column country     text not null default 'BJ' check (country ~ '^[A-Z]{2}$'),       -- ISO 3166-1 alpha-2
  add column time_zone   text not null default 'Africa/Porto-Novo'                       -- fuseau IANA (validé par l'API)
                         check (char_length(time_zone) between 3 and 64),
  add column cover_fit   text not null default 'cover' check (cover_fit in ('cover', 'contain')),
  add column likes_count integer not null default 0 check (likes_count >= 0);

-- Recherche et filtres de la liste publique
create index events_public_list_idx on public.events (status, starts_at) where status = 'PUBLISHED';
create index events_category_idx on public.events (category, starts_at) where status = 'PUBLISHED';

alter table public.ticket_categories
  add column description text not null default '' check (char_length(description) <= 300);

-- ---------------------------------------------------------------------------
-- Likes : un par appareil (deviceId généré par le front), compteur dénormalisé pour le tri « popular »
-- ---------------------------------------------------------------------------
create table public.event_likes (
  event_id   uuid not null references public.events (id) on delete cascade,
  device_id  text not null check (device_id ~ '^[A-Za-z0-9_-]{8,100}$'),
  created_at timestamptz not null default now(),
  primary key (event_id, device_id)
);
alter table public.event_likes enable row level security; -- aucune politique : accès par l'API uniquement

create or replace function public.tg_event_likes_count()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.events set likes_count = likes_count + 1 where id = new.event_id;
  else
    update public.events set likes_count = greatest(likes_count - 1, 0) where id = old.event_id;
  end if;
  return null;
end;
$$;

create trigger event_likes_count
after insert or delete on public.event_likes
for each row execute function public.tg_event_likes_count();

-- Un like ne doit pas changer la date de dernière modification de l'événement
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'likes_count' - 'updated_at') = (to_jsonb(old) - 'likes_count' - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- Lecture directe (hors API) : mêmes règles que les autres colonnes publiques
grant select (category, country, time_zone, cover_fit, likes_count) on public.events to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fonctions des événements : prise en compte des nouveaux champs
-- ---------------------------------------------------------------------------
create or replace function public.create_event(p_organizer_id uuid, p_slug text, p_event jsonb, p_categories jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_event_id uuid;
  v_cat jsonb;
  v_pos smallint := 0;
begin
  insert into public.events (slug, name, description, cover_image_url, venue, city, starts_at, ends_at, organizer_id,
                             category, country, time_zone, cover_fit)
  values (
    p_slug,
    p_event ->> 'name',
    coalesce(p_event ->> 'description', ''),
    p_event ->> 'coverImageUrl',
    p_event ->> 'venue',
    p_event ->> 'city',
    (p_event ->> 'startsAt')::timestamptz,
    (p_event ->> 'endsAt')::timestamptz,
    p_organizer_id,
    coalesce((p_event ->> 'category')::public.event_category, 'SOIREE'),
    coalesce(p_event ->> 'country', 'BJ'),
    coalesce(p_event ->> 'timeZone', 'Africa/Porto-Novo'),
    coalesce(p_event ->> 'coverFit', 'cover')
  )
  returning id into v_event_id;

  for v_cat in select * from jsonb_array_elements(p_categories) loop
    insert into public.ticket_categories (event_id, name, description, price_fcfa, quantity, position)
    values (v_event_id, v_cat ->> 'name', coalesce(v_cat ->> 'description', ''), (v_cat ->> 'priceFcfa')::int,
            (v_cat ->> 'quantity')::int, v_pos);
    v_pos := v_pos + 1;
  end loop;

  return v_event_id;
end;
$$;

create or replace function public.update_event(p_event_id uuid, p_organizer_id uuid, p_patch jsonb, p_categories jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
  v_cat jsonb;
  v_existing public.ticket_categories;
  v_new_id uuid;
  v_keep uuid[] := '{}';
  v_pos smallint := 0;
  v_count integer;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.organizer_id <> p_organizer_id then
    raise exception 'NOT_FOUND' using detail = 'Événement introuvable';
  end if;
  if v_event.status = 'CLOSED' then
    raise exception 'EVENT_CLOSED' using detail = 'Un événement clos ne peut plus être modifié';
  end if;

  update public.events set
    name            = coalesce(p_patch ->> 'name', name),
    description     = coalesce(p_patch ->> 'description', description),
    cover_image_url = case when p_patch ? 'coverImageUrl' then p_patch ->> 'coverImageUrl' else cover_image_url end,
    venue           = coalesce(p_patch ->> 'venue', venue),
    city            = coalesce(p_patch ->> 'city', city),
    starts_at       = coalesce((p_patch ->> 'startsAt')::timestamptz, starts_at),
    ends_at         = coalesce((p_patch ->> 'endsAt')::timestamptz, ends_at),
    category        = coalesce((p_patch ->> 'category')::public.event_category, category),
    country         = coalesce(p_patch ->> 'country', country),
    time_zone       = coalesce(p_patch ->> 'timeZone', time_zone),
    cover_fit       = coalesce(p_patch ->> 'coverFit', cover_fit)
  where id = p_event_id;

  if p_categories is null then
    return;
  end if;

  for v_cat in select * from jsonb_array_elements(p_categories) loop
    if v_cat ? 'id' and v_cat ->> 'id' is not null then
      select * into v_existing from public.ticket_categories
      where id = (v_cat ->> 'id')::uuid and event_id = p_event_id for update;
      if not found then
        raise exception 'CATEGORY_NOT_FOUND' using detail = 'Catégorie inconnue pour cet événement', hint = 'categories';
      end if;
      if (v_cat ->> 'quantity')::int < v_existing.sold then
        raise exception 'QUANTITY_BELOW_SOLD'
          using detail = format('La catégorie « %s » a déjà %s tickets vendus', v_existing.name, v_existing.sold),
                hint = 'categories';
      end if;
      update public.ticket_categories set
        name = v_cat ->> 'name',
        description = coalesce(v_cat ->> 'description', description),
        price_fcfa = (v_cat ->> 'priceFcfa')::int,
        quantity = (v_cat ->> 'quantity')::int,
        position = v_pos
      where id = v_existing.id;
      v_keep := v_keep || v_existing.id;
    else
      insert into public.ticket_categories (event_id, name, description, price_fcfa, quantity, position)
      values (p_event_id, v_cat ->> 'name', coalesce(v_cat ->> 'description', ''), (v_cat ->> 'priceFcfa')::int,
              (v_cat ->> 'quantity')::int, v_pos)
      returning id into v_new_id;
      v_keep := v_keep || v_new_id;
    end if;
    v_pos := v_pos + 1;
  end loop;

  if exists (
    select 1 from public.ticket_categories c
    where c.event_id = p_event_id and c.id <> all (v_keep)
      and (c.sold > 0 or exists (select 1 from public.order_items oi where oi.category_id = c.id))
  ) then
    raise exception 'CATEGORY_HAS_ORDERS'
      using detail = 'Impossible de supprimer une catégorie qui a déjà des commandes', hint = 'categories';
  end if;

  delete from public.ticket_categories c where c.event_id = p_event_id and c.id <> all (v_keep);

  select count(*) into v_count from public.ticket_categories where event_id = p_event_id;
  if v_count < 1 or v_count > 10 then
    raise exception 'VALIDATION_ERROR' using detail = 'Un événement doit avoir entre 1 et 10 catégories', hint = 'categories';
  end if;
end;
$$;

create or replace function public.list_organizer_events(p_organizer_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x."startsAt" desc), '[]'::jsonb)
  from (
    select
      e.id, e.slug, e.name, e.status, e.category, e.venue, e.city, e.country,
      e.time_zone as "timeZone",
      e.cover_image_url as "coverImageUrl", e.cover_fit as "coverFit",
      e.starts_at as "startsAt", e.ends_at as "endsAt",
      e.published_at as "publishedAt", e.created_at as "createdAt",
      e.likes_count as "likesCount",
      coalesce(c.capacity, 0) as capacity,
      coalesce(c.sold, 0) as "ticketsSold",
      coalesce(o.revenue, 0) as revenue,
      coalesce(t.scanned, 0) as "scannedCount"
    from public.events e
    left join lateral (
      select sum(quantity)::int as capacity, sum(sold)::int as sold
      from public.ticket_categories where event_id = e.id
    ) c on true
    left join lateral (
      select sum(total_amount)::int as revenue
      from public.orders where event_id = e.id and status = 'PAID'
    ) o on true
    left join lateral (
      select count(*)::int as scanned
      from public.tickets where event_id = e.id and status = 'SCANNED'
    ) t on true
    where e.organizer_id = p_organizer_id
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- Photo de la démo : compléter les lignes enregistrées avec les nouvelles colonnes
-- (sinon la remise à zéro nocturne insérerait des valeurs nulles et échouerait)
-- ---------------------------------------------------------------------------
update demo.snapshot set rows = (
  select coalesce(jsonb_agg(jsonb_build_object(
    'category', 'SOIREE', 'country', 'BJ', 'time_zone', 'Africa/Porto-Novo', 'cover_fit', 'cover', 'likes_count', 0) || r), '[]')
  from jsonb_array_elements(rows) r)
where table_name = 'events';

update demo.snapshot set rows = (
  select coalesce(jsonb_agg(jsonb_build_object('description', '') || r), '[]') from jsonb_array_elements(rows) r)
where table_name = 'ticket_categories';

-- La photo inclut désormais les likes du compte de démo
create or replace function public.demo_snapshot(p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select id into v_org from public.profiles where email = lower(trim(p_email));
  if v_org is null then
    raise exception 'DEMO_ACCOUNT_NOT_FOUND' using detail = p_email;
  end if;

  delete from demo.snapshot;
  delete from demo.config;
  insert into demo.config (organizer_id) values (v_org);

  insert into demo.snapshot (table_name, rows)
  select 'events', coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.events e where e.organizer_id = v_org
  union all
  select 'event_secrets', coalesce(jsonb_agg(to_jsonb(s)), '[]')
    from public.event_secrets s join public.events e on e.id = s.event_id where e.organizer_id = v_org
  union all
  select 'ticket_categories', coalesce(jsonb_agg(to_jsonb(c)), '[]')
    from public.ticket_categories c join public.events e on e.id = c.event_id where e.organizer_id = v_org
  union all
  select 'orders', coalesce(jsonb_agg(to_jsonb(o)), '[]')
    from public.orders o join public.events e on e.id = o.event_id where e.organizer_id = v_org
  union all
  select 'order_items', coalesce(jsonb_agg(to_jsonb(i)), '[]')
    from public.order_items i join public.orders o on o.id = i.order_id
    join public.events e on e.id = o.event_id where e.organizer_id = v_org
  union all
  select 'tickets', coalesce(jsonb_agg(to_jsonb(t)), '[]')
    from public.tickets t join public.events e on e.id = t.event_id where e.organizer_id = v_org
  union all
  select 'scan_events', coalesce(jsonb_agg(to_jsonb(x)), '[]')
    from public.scan_events x join public.events e on e.id = x.event_id where e.organizer_id = v_org
  union all
  select 'event_likes', coalesce(jsonb_agg(to_jsonb(l)), '[]')
    from public.event_likes l join public.events e on e.id = l.event_id where e.organizer_id = v_org;

  return (select jsonb_object_agg(table_name, jsonb_array_length(rows)) from demo.snapshot);
end;
$$;

-- Restauration : identique, plus les likes
create or replace function public.demo_reset()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_first timestamptz;
  v_weeks integer;
  v_shift interval;
begin
  select organizer_id into v_org from demo.config;
  if v_org is null or not exists (select 1 from public.profiles where id = v_org) then
    return jsonb_build_object('reset', false, 'reason', 'aucune photo de démo');
  end if;

  select min((r ->> 'starts_at')::timestamptz) into v_first
  from demo.snapshot s, jsonb_array_elements(s.rows) as r
  where s.table_name = 'events' and r ->> 'status' = 'PUBLISHED';
  v_weeks := greatest(0, ceil(extract(epoch from (now() + interval '1 day' - coalesce(v_first, now()))) / 604800)::integer);
  v_shift := make_interval(weeks => v_weeks);

  delete from public.events where organizer_id = v_org;

  insert into public.events
  select * from jsonb_populate_recordset(null::public.events,
    demo.shifted('events', array['starts_at', 'ends_at', 'published_at', 'created_at', 'updated_at'], v_shift));

  update public.event_secrets es
  set qr_secret = x.qr_secret, staff_pin_hash = x.staff_pin_hash
  from jsonb_populate_recordset(null::public.event_secrets, demo.shifted('event_secrets', '{}', v_shift)) x
  where es.event_id = x.event_id;

  insert into public.ticket_categories
  select * from jsonb_populate_recordset(null::public.ticket_categories,
    demo.shifted('ticket_categories', array['created_at'], v_shift));

  insert into public.orders
  select * from jsonb_populate_recordset(null::public.orders,
    demo.shifted('orders', array['created_at', 'paid_at'], v_shift));

  insert into public.order_items
  select * from jsonb_populate_recordset(null::public.order_items, demo.shifted('order_items', '{}', v_shift));

  insert into public.tickets
  select * from jsonb_populate_recordset(null::public.tickets,
    demo.shifted('tickets', array['scanned_at', 'created_at'], v_shift));

  insert into public.scan_events
  select * from jsonb_populate_recordset(null::public.scan_events,
    demo.shifted('scan_events', array['scanned_at', 'synced_at'], v_shift));

  insert into public.event_likes
  select * from jsonb_populate_recordset(null::public.event_likes, demo.shifted('event_likes', array['created_at'], v_shift));
  -- Le trigger a ajouté les likes au compteur déjà restauré : on le recalcule
  update public.events e
  set likes_count = (select count(*) from public.event_likes l where l.event_id = e.id)
  where e.organizer_id = v_org;

  return jsonb_build_object('reset', true, 'shiftWeeks', v_weeks,
    'events', (select count(*) from public.events where organizer_id = v_org));
end;
$$;

revoke all on function public.demo_snapshot(text) from public, anon, authenticated, service_role;
revoke all on function public.demo_reset() from public, anon, authenticated, service_role;
