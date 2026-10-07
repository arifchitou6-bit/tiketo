-- TICKETO — fonctions transactionnelles des événements (Phase 1)
-- SECURITY DEFINER + exécution réservée au service_role (Edge Function `api`).
-- Convention d'erreur : RAISE EXCEPTION '<CODE>' USING DETAIL = '<message>', HINT = '<champ>'
-- L'API convertit ces erreurs au format { error: { code, message, field? } }.

-- Crée l'événement et ses catégories dans une seule transaction.
create or replace function public.create_event(p_organizer_id uuid, p_slug text, p_event jsonb, p_categories jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_event_id uuid;
  v_cat jsonb;
  v_pos smallint := 0;
begin
  insert into public.events (slug, name, description, cover_image_url, venue, city, starts_at, ends_at, organizer_id)
  values (
    p_slug,
    p_event ->> 'name',
    coalesce(p_event ->> 'description', ''),
    p_event ->> 'coverImageUrl',
    p_event ->> 'venue',
    p_event ->> 'city',
    (p_event ->> 'startsAt')::timestamptz,
    (p_event ->> 'endsAt')::timestamptz,
    p_organizer_id
  )
  returning id into v_event_id;

  for v_cat in select * from jsonb_array_elements(p_categories) loop
    insert into public.ticket_categories (event_id, name, price_fcfa, quantity, position)
    values (v_event_id, v_cat ->> 'name', (v_cat ->> 'priceFcfa')::int, (v_cat ->> 'quantity')::int, v_pos);
    v_pos := v_pos + 1;
  end loop;

  return v_event_id;
end;
$$;

-- Mise à jour partielle. p_categories (optionnel) = liste complète souhaitée :
--   avec id -> modifiée ; sans id -> créée ; id absent de la liste -> supprimée (si aucune commande).
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
    ends_at         = coalesce((p_patch ->> 'endsAt')::timestamptz, ends_at)
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
        price_fcfa = (v_cat ->> 'priceFcfa')::int,
        quantity = (v_cat ->> 'quantity')::int,
        position = v_pos
      where id = v_existing.id;
      v_keep := v_keep || v_existing.id;
    else
      insert into public.ticket_categories (event_id, name, price_fcfa, quantity, position)
      values (p_event_id, v_cat ->> 'name', (v_cat ->> 'priceFcfa')::int, (v_cat ->> 'quantity')::int, v_pos)
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

-- Liste des événements d'un organisateur avec leurs indicateurs (une seule requête).
create or replace function public.list_organizer_events(p_organizer_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x."startsAt" desc), '[]'::jsonb)
  from (
    select
      e.id, e.slug, e.name, e.status, e.venue, e.city,
      e.cover_image_url as "coverImageUrl",
      e.starts_at as "startsAt", e.ends_at as "endsAt",
      e.published_at as "publishedAt", e.created_at as "createdAt",
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

revoke all on function public.create_event(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.update_event(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.list_organizer_events(uuid) from public, anon, authenticated;
grant execute on function public.create_event(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.update_event(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.list_organizer_events(uuid) to service_role;
