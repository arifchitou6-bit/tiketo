-- TICKETO — validation d'un scan (Phase 4, réutilisée par la synchro hors ligne en Phase 5)
-- Retourne { result: OK | DUPLICATE | INVALID, ticketId?, holderName?, category?, previousScanAt?, scannedAt, replayed? }

create or replace function public.scan_ticket(
  p_event_id uuid,
  p_staff_code text,
  p_qr_payload text,
  p_device_id text,
  p_scanned_at timestamptz,
  p_client_scan_id text default null,
  p_from_sync boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_parts text[];
  v_ticket public.tickets;
  v_secret text;
  v_category text;
  v_holder text;
  v_previous timestamptz;
  v_result public.scan_result;
  -- L'heure du scan fournie par l'appareil est conservée, mais jamais dans le futur.
  v_scanned_at timestamptz := least(coalesce(p_scanned_at, now()), now());
  v_prior public.scan_events;
begin
  -- Idempotence : un scan hors ligne renvoyé deux fois (même appareil + même identifiant) n'est traité qu'une fois.
  if p_client_scan_id is not null then
    select * into v_prior from public.scan_events
    where device_id = p_device_id and client_scan_id = p_client_scan_id;
    if found then
      select t.holder_name, c.name into v_holder, v_category
      from public.tickets t join public.ticket_categories c on c.id = t.category_id
      where t.id = v_prior.ticket_id;
      return jsonb_strip_nulls(jsonb_build_object(
        'result', v_prior.result, 'ticketId', v_prior.ticket_id, 'holderName', v_holder,
        'category', v_category, 'scannedAt', v_prior.scanned_at, 'replayed', true
      ));
    end if;
  end if;

  -- Format attendu : TCKT.{uuid}.{signature}
  v_parts := string_to_array(coalesce(p_qr_payload, ''), '.');
  if array_length(v_parts, 1) = 3
     and v_parts[1] = 'TCKT'
     and v_parts[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    -- Verrou : deux agents qui scannent le même ticket en même temps sont traités l'un après l'autre.
    select * into v_ticket from public.tickets where id = v_parts[2]::uuid for update;
  end if;

  if v_ticket.id is null or v_ticket.event_id <> p_event_id then
    -- Inconnu ou d'un autre événement : jamais relié au ticket d'un autre organisateur.
    v_result := 'INVALID';
    v_ticket := null;
  else
    select qr_secret into v_secret from public.event_secrets where event_id = p_event_id;
    if public.qr_signature(v_ticket.id::text, v_secret) <> v_parts[3] then
      v_result := 'INVALID'; -- signature falsifiée
      v_ticket := null;
    elsif v_ticket.status = 'INVALIDATED' then
      v_result := 'INVALID';
    elsif v_ticket.status = 'SCANNED' then
      v_result := 'DUPLICATE';
      v_previous := v_ticket.scanned_at;
      update public.tickets set scan_count = scan_count + 1 where id = v_ticket.id;
    else
      v_result := 'OK';
      update public.tickets
      set status = 'SCANNED', scanned_at = v_scanned_at, scan_count = scan_count + 1
      where id = v_ticket.id;
    end if;
  end if;

  insert into public.scan_events (ticket_id, event_id, staff_code, device_id, scanned_at, synced_at, result, client_scan_id)
  values (v_ticket.id, p_event_id, p_staff_code, p_device_id, v_scanned_at,
          case when p_from_sync then now() end, v_result, p_client_scan_id);

  if v_ticket.id is not null then
    select name into v_category from public.ticket_categories where id = v_ticket.category_id;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'result', v_result,
    'ticketId', v_ticket.id,
    'holderName', v_ticket.holder_name,
    'category', v_category,
    'previousScanAt', v_previous,
    'scannedAt', v_scanned_at
  ));
end;
$$;

revoke all on function public.scan_ticket(uuid, text, text, text, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.scan_ticket(uuid, text, text, text, timestamptz, text, boolean) to service_role;
