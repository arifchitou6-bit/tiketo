-- TICKETO — tâches planifiées (pg_cron, inclus dans Supabase)

-- Commandes PENDING de plus de p_ttl_minutes -> FAILED / ORDER_EXPIRED (PRD §7).
-- Retourne le nombre de commandes expirées.
create or replace function public.expire_pending_orders(p_ttl_minutes integer default 15)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.orders
  set status = 'FAILED', failure_reason = 'ORDER_EXPIRED'
  where status = 'PENDING' and created_at < now() - make_interval(mins => p_ttl_minutes);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_pending_orders(integer) from public, anon, authenticated;
grant execute on function public.expire_pending_orders(integer) to service_role;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

-- Toutes les 5 minutes : expiration des commandes non payées
select cron.schedule(
  'ticketo-expire-pending-orders',
  '*/5 * * * *',
  $$ select public.expire_pending_orders(15); $$
);

-- Toutes les heures (à hh:17) : purge des compteurs de rate limiting et des sessions staff périmées
select cron.schedule(
  'ticketo-cleanup',
  '17 * * * *',
  $$
    delete from public.rate_limits where window_start < now() - interval '1 hour';
    delete from public.staff_sessions where expires_at < now() - interval '7 days';
  $$
);
