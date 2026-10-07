-- TICKETO — durcissement (audit Phase 7)
-- Toutes les écritures passent par l'Edge Function `api` (service_role), qui applique les règles métier.
-- L'écriture directe via l'API REST de Supabase (clé publique + jeton utilisateur) les contournait :
-- un organisateur pouvait remettre `sold` à 0 sur ses catégories et provoquer une survente.
-- => plus aucun droit d'écriture directe pour anon / authenticated. La lecture (RLS) est conservée.

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

-- Les futures tables du schéma public n'auront pas non plus d'écriture directe par défaut
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;

-- Politiques d'écriture devenues sans objet
drop policy if exists "events: création par l'organisateur" on public.events;
drop policy if exists "events: modification par l'organisateur" on public.events;
drop policy if exists "events: suppression par l'organisateur" on public.events;
drop policy if exists "profiles: mise à jour de son profil" on public.profiles;
drop policy if exists "categories: gestion par l'organisateur" on public.ticket_categories;
create policy "categories: lecture par l'organisateur" on public.ticket_categories
  for select to authenticated using (public.is_event_owner(event_id));

-- Fonctions techniques : pas d'exécution directe par le public.
-- is_event_owner reste exécutable par `authenticated` : les politiques de lecture RLS l'utilisent.
revoke execute on function public.tg_set_updated_at() from public, anon, authenticated;
revoke execute on function public.tg_create_event_secret() from public, anon, authenticated;
revoke execute on function public.tg_handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_event_owner(uuid) from public, anon;
grant execute on function public.is_event_owner(uuid) to authenticated;
