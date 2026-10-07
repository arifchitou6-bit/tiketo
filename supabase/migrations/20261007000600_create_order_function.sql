-- TICKETO — création d'une commande (Phase 3)
-- La commande est créée en PENDING ; le prix est toujours celui de la base (jamais celui du client).

-- Code aléatoire sans caractères ambigus (0/O, 1/I/L) : références de paiement, codes staff.
create or replace function public.random_code(p_length integer)
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(p_length);
  v_out text := '';
begin
  for i in 0 .. p_length - 1 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;
  return v_out;
end;
$$;

create or replace function public.create_order(p_slug text, p_items jsonb, p_buyer jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
  v_order_id uuid;
  v_item record;
  v_total_qty integer := 0;
  v_reference text;
begin
  select * into v_event from public.events where slug = p_slug;
  if not found or v_event.status = 'DRAFT' then
    raise exception 'NOT_FOUND' using detail = 'Événement introuvable';
  end if;
  if v_event.status = 'CLOSED' then
    raise exception 'EVENT_CLOSED' using detail = 'La billetterie de cet événement est fermée';
  end if;
  if v_event.ends_at <= now() then
    raise exception 'EVENT_ENDED' using detail = 'Cet événement est terminé';
  end if;

  -- Une même catégorie peut apparaître plusieurs fois dans le panier : on agrège.
  for v_item in
    select (i ->> 'categoryId')::uuid as category_id, sum((i ->> 'quantity')::int)::int as quantity
    from jsonb_array_elements(p_items) i
    group by 1
  loop
    perform 1 from public.ticket_categories c where c.id = v_item.category_id and c.event_id = v_event.id;
    if not found then
      raise exception 'CATEGORY_NOT_FOUND' using detail = 'Catégorie inconnue pour cet événement', hint = 'items';
    end if;
    if exists (
      select 1 from public.ticket_categories c
      where c.id = v_item.category_id and c.quantity - c.sold < v_item.quantity
    ) then
      raise exception 'SOLD_OUT'
        using detail = 'Il ne reste plus assez de tickets dans cette catégorie', hint = v_item.category_id::text;
    end if;
    v_total_qty := v_total_qty + v_item.quantity;
  end loop;

  if v_total_qty < 1 or v_total_qty > 20 then
    raise exception 'VALIDATION_ERROR' using detail = 'Une commande contient entre 1 et 20 tickets', hint = 'items';
  end if;

  loop
    v_reference := 'TKO-' || public.random_code(10);
    exit when not exists (select 1 from public.orders where payment_reference = v_reference);
  end loop;

  insert into public.orders (event_id, buyer_name, buyer_phone, buyer_email, total_amount, payment_provider, payment_reference)
  values (v_event.id, p_buyer ->> 'name', p_buyer ->> 'phone', nullif(p_buyer ->> 'email', ''), 0,
          p_buyer ->> 'provider', v_reference)
  returning id into v_order_id;

  insert into public.order_items (order_id, category_id, quantity, unit_price_fcfa)
  select v_order_id, c.id, agg.quantity, c.price_fcfa
  from (
    select (i ->> 'categoryId')::uuid as category_id, sum((i ->> 'quantity')::int)::int as quantity
    from jsonb_array_elements(p_items) i group by 1
  ) agg
  join public.ticket_categories c on c.id = agg.category_id;

  update public.orders
  set total_amount = (select coalesce(sum(quantity * unit_price_fcfa), 0) from public.order_items where order_id = v_order_id)
  where id = v_order_id;

  return v_order_id;
end;
$$;

revoke all on function public.random_code(integer) from public, anon, authenticated;
revoke all on function public.create_order(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.random_code(integer) to service_role;
grant execute on function public.create_order(text, jsonb, jsonb) to service_role;
