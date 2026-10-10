-- TICKETO — PRD v2.1 §8.5 : brouillon avec le nom seul, contrôles complets à la publication
--   · lieu, ville, dates et catégorie facultatifs en brouillon ; catégorie obligatoire pour publier
--   · description d'une catégorie de tickets : 80 caractères maximum
--   · pays BJ ou CI ; fuseau horaire déduit du pays s'il n'est pas fourni

alter table public.events
  alter column venue drop not null,
  alter column city drop not null,
  alter column starts_at drop not null,
  alter column ends_at drop not null,
  alter column category drop not null,
  alter column category drop default;

-- Pays couverts : Bénin et Côte d'Ivoire (PRD v2.1 §7)
alter table public.events drop constraint events_country_check;
alter table public.events add constraint events_country_check check (country in ('BJ', 'CI'));

alter table public.ticket_categories drop constraint ticket_categories_description_check;
alter table public.ticket_categories add constraint ticket_categories_description_check
  check (char_length(description) <= 80);

-- Fuseau par défaut d'un pays
create or replace function public.country_time_zone(p_country text)
returns text language sql immutable set search_path = '' as $$
  select case p_country when 'CI' then 'Africa/Abidjan' else 'Africa/Porto-Novo' end;
$$;

-- ---------------------------------------------------------------------------
-- Création : seul le nom est obligatoire (brouillon)
-- ---------------------------------------------------------------------------
create or replace function public.create_event(p_organizer_id uuid, p_slug text, p_event jsonb, p_categories jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_event_id uuid;
  v_cat jsonb;
  v_pos smallint := 0;
  v_country text := coalesce(p_event ->> 'country', 'BJ');
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
    (p_event ->> 'category')::public.event_category,
    v_country,
    coalesce(p_event ->> 'timeZone', public.country_time_zone(v_country)),
    coalesce(p_event ->> 'coverFit', 'cover')
  )
  returning id into v_event_id;

  for v_cat in select * from jsonb_array_elements(coalesce(p_categories, '[]'::jsonb)) loop
    insert into public.ticket_categories (event_id, name, description, price_fcfa, quantity, position)
    values (v_event_id, v_cat ->> 'name', coalesce(v_cat ->> 'description', ''), (v_cat ->> 'priceFcfa')::int,
            (v_cat ->> 'quantity')::int, v_pos);
    v_pos := v_pos + 1;
  end loop;

  return v_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Modification : un brouillon peut n'avoir aucune catégorie de tickets ; un événement publié en garde au moins une
-- ---------------------------------------------------------------------------
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
    -- Pays changé sans fuseau précisé : fuseau du nouveau pays
    time_zone       = coalesce(p_patch ->> 'timeZone',
                               case when p_patch ? 'country' then public.country_time_zone(p_patch ->> 'country') end,
                               time_zone),
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
  if v_count > 10 or (v_count < 1 and v_event.status <> 'DRAFT') then
    raise exception 'VALIDATION_ERROR' using detail = 'Un événement publié doit avoir entre 1 et 10 catégories', hint = 'categories';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publication : tout doit être rempli (PRD v2.1 §8.5), un champ manquant à la fois avec son nom
-- ---------------------------------------------------------------------------
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

  if v_event.category is null then
    raise exception 'VALIDATION_ERROR' using detail = 'Choisissez une catégorie avant de publier', hint = 'category';
  end if;
  if coalesce(trim(v_event.venue), '') = '' then
    raise exception 'VALIDATION_ERROR' using detail = 'Indiquez le lieu avant de publier', hint = 'venue';
  end if;
  if coalesce(trim(v_event.city), '') = '' then
    raise exception 'VALIDATION_ERROR' using detail = 'Indiquez la ville avant de publier', hint = 'city';
  end if;
  if v_event.starts_at is null then
    raise exception 'VALIDATION_ERROR' using detail = 'Indiquez la date de début avant de publier', hint = 'startsAt';
  end if;
  if v_event.ends_at is null then
    raise exception 'VALIDATION_ERROR' using detail = 'Indiquez la date de fin avant de publier', hint = 'endsAt';
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

revoke all on function public.country_time_zone(text) from public, anon, authenticated;
