-- TICKETO — remise à zéro automatique du compte de démonstration
-- Les accès démo sont publics (README, bouton « connexion en un clic » du front) : n'importe qui peut
-- modifier, clôturer ou supprimer les événements de démo, ou régénérer le code staff.
-- On photographie l'état de référence une fois (demo_snapshot), puis pg_cron le restaure chaque nuit
-- (demo_reset) à l'identique : mêmes identifiants, slugs, codes staff, PIN, QR et liens de commande.
-- Les dates sont décalées d'un nombre entier de semaines pour que la démo reste à venir (et un samedi).

-- ---------------------------------------------------------------------------
-- Stockage de la référence : schéma privé, non exposé par l'API REST
-- ---------------------------------------------------------------------------
create schema if not exists demo;
revoke all on schema demo from public, anon, authenticated;

create table demo.config (
  id           boolean primary key default true check (id), -- une seule ligne
  organizer_id uuid not null,
  taken_at     timestamptz not null default now()
);

-- Une ligne par table : toutes les lignes du compte de démo au format JSON
-- (résiste aux colonnes ajoutées plus tard ; reprendre la photo après une migration de schéma).
create table demo.snapshot (
  table_name text primary key,
  rows       jsonb not null
);

alter table demo.config enable row level security;
alter table demo.snapshot enable row level security;
revoke all on all tables in schema demo from public, anon, authenticated;

-- Lignes d'une table de la photo, avec les colonnes de date décalées de p_shift
create or replace function demo.shifted(p_table text, p_keys text[], p_shift interval)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg((
    select jsonb_object_agg(
      e.k,
      case when e.k = any (p_keys) and jsonb_typeof(e.v) = 'string'
           then to_jsonb((e.v #>> '{}')::timestamptz + p_shift)
           else e.v end)
    from jsonb_each(r) as e (k, v)
  )), '[]'::jsonb)
  from demo.snapshot s, jsonb_array_elements(s.rows) as r
  where s.table_name = p_table;
$$;

-- ---------------------------------------------------------------------------
-- Photo de l'état de référence (à lancer après le seed ou après une modification voulue de la démo)
-- ---------------------------------------------------------------------------
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
    from public.scan_events x join public.events e on e.id = x.event_id where e.organizer_id = v_org;

  return (select jsonb_object_agg(table_name, jsonb_array_length(rows)) from demo.snapshot);
end;
$$;

-- ---------------------------------------------------------------------------
-- Restauration : supprime tout ce que possède le compte de démo et recharge la photo
-- ---------------------------------------------------------------------------
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

  -- Décalage minimal (en semaines) pour que le premier événement publié commence dans plus de 24 h
  select min((r ->> 'starts_at')::timestamptz) into v_first
  from demo.snapshot s, jsonb_array_elements(s.rows) as r
  where s.table_name = 'events' and r ->> 'status' = 'PUBLISHED';
  v_weeks := greatest(0, ceil(extract(epoch from (now() + interval '1 day' - coalesce(v_first, now()))) / 604800)::integer);
  v_shift := make_interval(weeks => v_weeks);

  -- Suppression en cascade : catégories, commandes, tickets, scans, sessions staff, secrets
  delete from public.events where organizer_id = v_org;

  insert into public.events
  select * from jsonb_populate_recordset(null::public.events,
    demo.shifted('events', array['starts_at', 'ends_at', 'published_at', 'created_at', 'updated_at'], v_shift));

  -- Le trigger a créé de nouveaux secrets : on remet ceux d'origine (QR et PIN inchangés)
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

  return jsonb_build_object('reset', true, 'shiftWeeks', v_weeks,
    'events', (select count(*) from public.events where organizer_id = v_org));
end;
$$;

revoke all on function public.demo_snapshot(text) from public, anon, authenticated, service_role;
revoke all on function public.demo_reset() from public, anon, authenticated, service_role;
revoke all on function demo.shifted(text, text[], interval) from public, anon, authenticated, service_role;

-- Chaque nuit à 3 h, heure de Cotonou (2 h UTC)
select cron.schedule('ticketo-demo-reset', '0 2 * * *', $$ select public.demo_reset(); $$);
