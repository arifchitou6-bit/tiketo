-- TICKETO — Row Level Security + Storage
-- L'API (Edge Function) utilise le service_role et applique elle-même les contrôles de propriété.
-- La RLS est une seconde barrière : elle protège les données si le front interroge
-- Supabase directement (supabase-js, Realtime).

alter table public.profiles          enable row level security;
alter table public.events            enable row level security;
alter table public.event_secrets     enable row level security; -- aucune politique : service_role uniquement
alter table public.ticket_categories enable row level security;
alter table public.orders            enable row level security;
alter table public.order_items       enable row level security;
alter table public.tickets           enable row level security;
alter table public.scan_events       enable row level security;
alter table public.staff_sessions    enable row level security; -- aucune politique
alter table public.rate_limits       enable row level security; -- aucune politique

create or replace function public.is_event_owner(p_event_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event_id and e.organizer_id = (select auth.uid())
  );
$$;

-- profiles
create policy "profiles: lecture de son profil" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: mise à jour de son profil" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- events
create policy "events: lecture publique des événements publiés" on public.events
  for select to anon, authenticated using (status in ('PUBLISHED', 'CLOSED'));
create policy "events: lecture par l'organisateur" on public.events
  for select to authenticated using (organizer_id = (select auth.uid()));
create policy "events: création par l'organisateur" on public.events
  for insert to authenticated with check (organizer_id = (select auth.uid()));
create policy "events: modification par l'organisateur" on public.events
  for update to authenticated using (organizer_id = (select auth.uid())) with check (organizer_id = (select auth.uid()));
create policy "events: suppression par l'organisateur" on public.events
  for delete to authenticated using (organizer_id = (select auth.uid()));

-- La colonne staff_code n'est jamais lisible en direct (l'organisateur la lit via l'API).
revoke select on public.events from anon, authenticated;
grant select (id, slug, name, description, cover_image_url, venue, city, starts_at, ends_at, status, published_at)
  on public.events to anon;
grant select (id, slug, name, description, cover_image_url, venue, city, starts_at, ends_at, status, published_at,
              organizer_id, created_at, updated_at)
  on public.events to authenticated;

-- ticket_categories
create policy "categories: lecture publique si événement publié" on public.ticket_categories
  for select to anon, authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.status in ('PUBLISHED', 'CLOSED'))
  );
create policy "categories: gestion par l'organisateur" on public.ticket_categories
  for all to authenticated using (public.is_event_owner(event_id)) with check (public.is_event_owner(event_id));

-- orders / order_items / tickets / scan_events : lecture organisateur uniquement
create policy "orders: lecture par l'organisateur" on public.orders
  for select to authenticated using (public.is_event_owner(event_id));
create policy "order_items: lecture par l'organisateur" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_id and public.is_event_owner(o.event_id))
  );
create policy "tickets: lecture par l'organisateur" on public.tickets
  for select to authenticated using (public.is_event_owner(event_id));
create policy "scan_events: lecture par l'organisateur" on public.scan_events
  for select to authenticated using (public.is_event_owner(event_id));

-- ---------------------------------------------------------------------------
-- Storage : images de couverture
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-covers', 'event-covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Upload direct possible depuis le front dans le dossier <uid>/...
create policy "covers: upload dans son dossier" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'event-covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "covers: remplacement dans son dossier" on storage.objects
  for update to authenticated
  using (bucket_id = 'event-covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "covers: suppression dans son dossier" on storage.objects
  for delete to authenticated
  using (bucket_id = 'event-covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
