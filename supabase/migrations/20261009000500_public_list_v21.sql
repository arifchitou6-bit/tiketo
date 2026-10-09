-- TICKETO — PRD v2.1 §8.1 et §8.3 : ajustements de la liste publique, likes d'un appareil
--   · recherche dans le nom, le lieu et la ville (plus la description)
--   · tri « popular » : likes décroissants, puis tickets vendus décroissants, puis date
--   · GET /public/likes : événements aimés par un appareil (et par l'acheteur connecté)

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
  v_c_sold integer := coalesce((p_cursor ->> 'v')::integer, 0);
  v_rows jsonb;
  v_last jsonb;
begin
  -- Recherche insensible aux accents et à la casse ; chaque mot doit apparaître (nom, lieu ou ville)
  if coalesce(trim(p_q), '') <> '' then
    v_tokens := regexp_split_to_array(lower(extensions.unaccent(trim(p_q))), '\s+');
  end if;

  with cards as (
    select
      e.id, e.slug, e.name, e.category,
      e.cover_image_url as "coverImageUrl", e.cover_fit as "coverFit",
      e.venue, e.city, e.country, e.time_zone as "timeZone",
      e.starts_at as "startsAt", e.ends_at as "endsAt",
      e.likes_count as "likesCount",
      coalesce(c.sold, 0) as sold,
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
             bool_and(sold >= quantity) as sold_out,
             sum(sold)::int as sold
      from public.ticket_categories where event_id = e.id
    ) c on true
    where e.status = 'PUBLISHED'
      and e.ends_at > now()
      and (p_category is null or e.category = p_category)
      and (p_country is null or e.country = p_country)
      and not exists (
        select 1 from unnest(v_tokens) t
        where position(t in lower(extensions.unaccent(e.name || ' ' || e.venue || ' ' || e.city))) = 0
      )
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.ord), '[]'::jsonb) into v_rows
  from (
    select row_number() over (
             order by case when v_popular then k."likesCount" end desc nulls last,
                      case when v_popular then k.sold end desc nulls last,
                      k."startsAt", k.id) as ord,
           k.*
    from cards k
    where p_cursor is null
       or (not v_popular and (k."startsAt", k.id) > (v_c_starts, v_c_id))
       or (v_popular and (k."likesCount" < v_c_likes
                          or (k."likesCount" = v_c_likes and k.sold < v_c_sold)
                          or (k."likesCount" = v_c_likes and k.sold = v_c_sold and (k."startsAt", k.id) > (v_c_starts, v_c_id))))
    order by ord
    limit p_limit + 1
  ) x;

  if jsonb_array_length(v_rows) > p_limit then
    v_rows := v_rows - p_limit; -- la ligne en trop indique seulement qu'une page suivante existe
    v_last := v_rows -> (p_limit - 1);
  end if;

  return jsonb_build_object(
    'events', (select coalesce(jsonb_agg(r - 'ord' - 'sold' - case when p_device_id is null then 'isLiked' else '' end), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r),
    'next', case when v_last is null then null
                 else jsonb_build_object('s', v_last -> 'startsAt', 'id', v_last -> 'id', 'l', v_last -> 'likesCount',
                                         'v', v_last -> 'sold') end
  );
end;
$$;

-- Événements aimés par un appareil (et par l'acheteur connecté, tous appareils confondus)
create or replace function public.liked_slugs(p_device_id text, p_buyer_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct e.slug), '[]'::jsonb)
  from public.event_likes l
  join public.events e on e.id = l.event_id and e.status in ('PUBLISHED', 'CLOSED')
  where l.device_id = p_device_id or (p_buyer_id is not null and l.buyer_id = p_buyer_id);
$$;

revoke all on function public.liked_slugs(text, uuid) from public, anon, authenticated;
grant execute on function public.liked_slugs(text, uuid) to service_role;
