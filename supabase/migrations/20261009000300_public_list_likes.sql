-- TICKETO — PRD v2 : liste et recherche publique des événements, likes par appareil

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- Liste publique (accueil + recherche) — pagination par curseur (keyset)
--   p_sort   : 'date' (le plus proche d'abord) ou 'popular' (le plus liké d'abord, puis date)
--   p_cursor : { s: starts_at, id, l: likes_count } de la dernière ligne de la page précédente
-- Renvoie { events: [...], next: curseur | null }
-- ---------------------------------------------------------------------------
create or replace function public.list_public_events(
  p_q text, p_category public.event_category, p_country text, p_sort text, p_cursor jsonb, p_limit integer,
  p_device_id text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tokens text[] := '{}';
  v_popular boolean := p_sort = 'popular';
  v_c_starts timestamptz := (p_cursor ->> 's')::timestamptz;
  v_c_id uuid := (p_cursor ->> 'id')::uuid;
  v_c_likes integer := (p_cursor ->> 'l')::integer;
  v_rows jsonb;
  v_count integer;
  v_last jsonb;
begin
  -- Recherche insensible aux accents et à la casse ; chaque mot doit apparaître
  if coalesce(trim(p_q), '') <> '' then
    v_tokens := regexp_split_to_array(lower(extensions.unaccent(trim(p_q))), '\s+');
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.ord), '[]'::jsonb) into v_rows
  from (
    select
      row_number() over (order by case when v_popular then e.likes_count end desc nulls last, e.starts_at, e.id) as ord,
      e.id, e.slug, e.name, e.category,
      e.cover_image_url as "coverImageUrl", e.cover_fit as "coverFit",
      e.venue, e.city, e.country, e.time_zone as "timeZone",
      e.starts_at as "startsAt", e.ends_at as "endsAt",
      e.likes_count as "likesCount",
      coalesce(c.min_available, c.min_all) as "minPriceFcfa",
      coalesce(c.sold_out, false) as "isSoldOut",
      not coalesce(c.sold_out, false) as "isSalesOpen",
      case when p_device_id is null then null
           else exists (select 1 from public.event_likes l where l.event_id = e.id and l.device_id = p_device_id)
      end as "isLiked"
    from public.events e
    left join lateral (
      select min(price_fcfa) filter (where sold < quantity) as min_available,
             min(price_fcfa) as min_all,
             bool_and(sold >= quantity) as sold_out
      from public.ticket_categories where event_id = e.id
    ) c on true
    where e.status = 'PUBLISHED'
      and e.ends_at > now()
      and (p_category is null or e.category = p_category)
      and (p_country is null or e.country = p_country)
      and not exists (
        select 1 from unnest(v_tokens) t
        where position(t in lower(extensions.unaccent(e.name || ' ' || e.venue || ' ' || e.city || ' ' || e.description))) = 0
      )
      and (
        p_cursor is null
        or (not v_popular and (e.starts_at, e.id) > (v_c_starts, v_c_id))
        or (v_popular and (e.likes_count < v_c_likes
                           or (e.likes_count = v_c_likes and (e.starts_at, e.id) > (v_c_starts, v_c_id))))
      )
    order by case when v_popular then e.likes_count end desc nulls last, e.starts_at, e.id
    limit p_limit + 1
  ) x;

  v_count := jsonb_array_length(v_rows);
  if v_count > p_limit then
    v_rows := v_rows - p_limit; -- la ligne en trop indique seulement qu'une page suivante existe
    v_last := v_rows -> (p_limit - 1);
    return jsonb_build_object(
      'events', (select jsonb_agg(r - 'ord' - case when p_device_id is null then 'isLiked' else '' end) from jsonb_array_elements(v_rows) r),
      'next', jsonb_build_object('s', v_last -> 'startsAt', 'id', v_last -> 'id', 'l', v_last -> 'likesCount')
    );
  end if;
  return jsonb_build_object(
    'events', (select coalesce(jsonb_agg(r - 'ord' - case when p_device_id is null then 'isLiked' else '' end), '[]'::jsonb) from jsonb_array_elements(v_rows) r),
    'next', null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Like / unlike (idempotent) — événements publiés ou clos uniquement
-- ---------------------------------------------------------------------------
create or replace function public.set_event_like(p_slug text, p_device_id text, p_liked boolean)
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
    insert into public.event_likes (event_id, device_id) values (v_event_id, p_device_id) on conflict do nothing;
  else
    delete from public.event_likes where event_id = v_event_id and device_id = p_device_id;
  end if;

  select likes_count into v_count from public.events where id = v_event_id;
  return jsonb_build_object('liked', p_liked, 'likesCount', v_count);
end;
$$;

create or replace function public.is_event_liked(p_event_id uuid, p_device_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.event_likes where event_id = p_event_id and device_id = p_device_id);
$$;

revoke all on function public.list_public_events(text, public.event_category, text, text, jsonb, integer, text)
  from public, anon, authenticated;
revoke all on function public.set_event_like(text, text, boolean) from public, anon, authenticated;
revoke all on function public.is_event_liked(uuid, text) from public, anon, authenticated;
grant execute on function public.list_public_events(text, public.event_category, text, text, jsonb, integer, text)
  to service_role;
grant execute on function public.set_event_like(text, text, boolean) to service_role;
grant execute on function public.is_event_liked(uuid, text) to service_role;
