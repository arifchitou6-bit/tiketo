-- TICKETO — paiement simulé + génération des tickets signés (Phase 3)

-- Signature HMAC-SHA256 du ticket, encodée en base64url (sans padding).
-- Payload QR : TCKT.{ticketId}.{qr_signature(ticketId, secret de l'événement)}
create or replace function public.qr_signature(p_ticket_id text, p_secret text)
returns text language sql immutable set search_path = '' as $$
  select rtrim(translate(encode(extensions.hmac(p_ticket_id, p_secret, 'sha256'), 'base64'), '+/', '-_'), '=');
$$;

-- Paiement : transactionnel, idempotent, sans survente possible.
-- Retourne { status: 'PAID' } ou { status: 'FAILED', reason: 'ORDER_EXPIRED' | 'EVENT_CLOSED' | 'SOLD_OUT' }.
-- Un échec métier n'est PAS une exception : la commande doit rester enregistrée en FAILED.
create or replace function public.pay_order(p_order_id uuid, p_ttl_minutes integer default 15)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
  v_event public.events;
  v_secret text;
  v_item record;
  v_ticket_id uuid;
  v_payload text;
begin
  -- Verrou sur la commande : deux confirmations simultanées sont traitées l'une après l'autre.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Commande introuvable';
  end if;
  if v_order.status = 'PAID' then
    return jsonb_build_object('status', 'PAID'); -- idempotent : aucun ticket en double
  end if;
  if v_order.status = 'FAILED' then
    return jsonb_build_object('status', 'FAILED', 'reason', coalesce(v_order.failure_reason, 'FAILED'));
  end if;

  if v_order.created_at < now() - make_interval(mins => p_ttl_minutes) then
    update public.orders set status = 'FAILED', failure_reason = 'ORDER_EXPIRED' where id = p_order_id;
    return jsonb_build_object('status', 'FAILED', 'reason', 'ORDER_EXPIRED');
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  if v_event.status <> 'PUBLISHED' or v_event.ends_at <= now() then
    update public.orders set status = 'FAILED', failure_reason = 'EVENT_CLOSED' where id = p_order_id;
    return jsonb_build_object('status', 'FAILED', 'reason', 'EVENT_CLOSED');
  end if;

  -- Verrouille les catégories dans un ordre stable (évite les interblocages) puis vérifie les quotas.
  perform 1 from public.ticket_categories c
  where c.id in (select category_id from public.order_items where order_id = p_order_id)
  order by c.id
  for update;

  if exists (
    select 1 from public.order_items oi
    join public.ticket_categories c on c.id = oi.category_id
    where oi.order_id = p_order_id and c.sold + oi.quantity > c.quantity
  ) then
    update public.orders set status = 'FAILED', failure_reason = 'SOLD_OUT' where id = p_order_id;
    return jsonb_build_object('status', 'FAILED', 'reason', 'SOLD_OUT');
  end if;

  select qr_secret into v_secret from public.event_secrets where event_id = v_event.id;

  for v_item in
    select oi.category_id, oi.quantity
    from public.order_items oi
    join public.ticket_categories c on c.id = oi.category_id
    where oi.order_id = p_order_id
    order by c.position
  loop
    update public.ticket_categories set sold = sold + v_item.quantity where id = v_item.category_id;

    for i in 1 .. v_item.quantity loop
      v_ticket_id := gen_random_uuid();
      v_payload := 'TCKT.' || v_ticket_id::text || '.' || public.qr_signature(v_ticket_id::text, v_secret);
      insert into public.tickets (id, order_id, category_id, event_id, holder_name, qr_payload, qr_hash)
      values (
        v_ticket_id, p_order_id, v_item.category_id, v_event.id, v_order.buyer_name,
        v_payload, encode(extensions.digest(v_payload, 'sha256'), 'hex')
      );
    end loop;
  end loop;

  update public.orders set status = 'PAID', paid_at = now() where id = p_order_id;
  return jsonb_build_object('status', 'PAID');
end;
$$;

revoke all on function public.qr_signature(text, text) from public, anon, authenticated;
revoke all on function public.pay_order(uuid, integer) from public, anon, authenticated;
grant execute on function public.qr_signature(text, text) to service_role;
grant execute on function public.pay_order(uuid, integer) to service_role;
