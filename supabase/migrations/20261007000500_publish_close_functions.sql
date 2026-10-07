-- TICKETO — publication et clôture d'un événement (Phase 2)
-- Verrou de ligne (FOR UPDATE) : deux requêtes simultanées ne peuvent pas changer le statut en même temps.

create or replace function public.publish_event(p_event_id uuid, p_organizer_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.organizer_id <> p_organizer_id then
    raise exception 'NOT_FOUND' using detail = 'Événement introuvable';
  end if;
  if v_event.status = 'PUBLISHED' then
    return v_event.slug; -- idempotent
  end if;
  if v_event.status = 'CLOSED' then
    raise exception 'EVENT_CLOSED' using detail = 'Un événement clos ne peut pas être republié';
  end if;
  if v_event.ends_at <= now() then
    raise exception 'EVENT_ENDED' using detail = 'La date de fin de l''événement est passée', hint = 'endsAt';
  end if;
  if not exists (select 1 from public.ticket_categories where event_id = p_event_id) then
    raise exception 'NO_CATEGORY' using detail = 'Ajoutez au moins une catégorie de tickets avant de publier', hint = 'categories';
  end if;

  update public.events set status = 'PUBLISHED', published_at = now() where id = p_event_id;
  return v_event.slug;
end;
$$;

create or replace function public.close_event(p_event_id uuid, p_organizer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.organizer_id <> p_organizer_id then
    raise exception 'NOT_FOUND' using detail = 'Événement introuvable';
  end if;
  if v_event.status = 'CLOSED' then
    return; -- idempotent
  end if;
  if v_event.status = 'DRAFT' then
    raise exception 'EVENT_NOT_PUBLISHED' using detail = 'Un brouillon ne peut pas être clos : supprimez-le ou publiez-le';
  end if;

  update public.events set status = 'CLOSED' where id = p_event_id;
end;
$$;

revoke all on function public.publish_event(uuid, uuid) from public, anon, authenticated;
revoke all on function public.close_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.publish_event(uuid, uuid) to service_role;
grant execute on function public.close_event(uuid, uuid) to service_role;
