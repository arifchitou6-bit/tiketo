-- TICKETO — statistiques du dashboard événement (Phase 6, US-07)
-- Tout est calculé en UNE requête (pas de N+1) : adapté au polling toutes les 10 secondes.
-- La recette utilise le prix payé au moment de l'achat (order_items.unit_price_fcfa), pas le prix actuel.

create or replace function public.event_stats(p_event_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with cats as (
    select c.id, c.name, c.price_fcfa, c.quantity, c.sold, c.position
    from public.ticket_categories c where c.event_id = p_event_id
  ),
  paid_items as (
    select oi.category_id, oi.quantity, oi.unit_price_fcfa, o.paid_at
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.event_id = p_event_id and o.status = 'PAID'
  ),
  scanned as (
    select t.category_id, count(*)::int as n
    from public.tickets t where t.event_id = p_event_id and t.status = 'SCANNED'
    group by t.category_id
  ),
  order_counts as (
    select
      count(*) filter (where status = 'PAID')::int as paid,
      count(*) filter (where status = 'PENDING')::int as pending,
      count(*) filter (where status = 'FAILED')::int as failed
    from public.orders where event_id = p_event_id
  ),
  totals as (
    select coalesce(sum(quantity), 0)::int as capacity, coalesce(sum(sold), 0)::int as sold from cats
  )
  select jsonb_build_object(
    'ticketsSold', totals.sold,
    'capacity', totals.capacity,
    'revenue', (select coalesce(sum(quantity * unit_price_fcfa), 0)::int from paid_items),
    'fillRate', case when totals.capacity = 0 then 0 else round(totals.sold * 100.0 / totals.capacity, 1) end,
    'scannedCount', (select coalesce(sum(n), 0)::int from scanned),
    'orders', jsonb_build_object('paid', order_counts.paid, 'pending', order_counts.pending, 'failed', order_counts.failed),
    'byCategory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'categoryId', c.id,
        'name', c.name,
        'priceFcfa', c.price_fcfa,
        'quantity', c.quantity,
        'sold', c.sold,
        'remaining', c.quantity - c.sold,
        'revenue', coalesce((select sum(pi.quantity * pi.unit_price_fcfa) from paid_items pi where pi.category_id = c.id), 0),
        'scanned', coalesce((select s.n from scanned s where s.category_id = c.id), 0)
      ) order by c.position)
      from cats c
    ), '[]'::jsonb),
    -- Ventes par heure (UTC)
    'salesOverTime', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b, 'tickets', tickets, 'revenue', revenue) order by b)
      from (
        select date_trunc('hour', paid_at) as b, sum(quantity)::int as tickets, sum(quantity * unit_price_fcfa)::int as revenue
        from paid_items group by 1
      ) s
    ), '[]'::jsonb),
    -- Entrées validées par tranche de 15 minutes (doublons et invalides exclus)
    'scansOverTime', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b, 'count', n) order by b)
      from (
        select date_bin('15 minutes', se.scanned_at, timestamptz '2000-01-01') as b, count(*)::int as n
        from public.scan_events se
        where se.event_id = p_event_id and se.result = 'OK'
        group by 1
      ) s
    ), '[]'::jsonb),
    'generatedAt', now()
  )
  from totals, order_counts;
$$;

revoke all on function public.event_stats(uuid) from public, anon, authenticated;
grant execute on function public.event_stats(uuid) to service_role;
