-- TICKETO — synchronisation des scans hors ligne (Phase 5)
-- Traite un lot de scans en UN appel, dans l'ordre chronologique réel (scannedAt) :
-- en cas de conflit entre appareils, le premier scan gagne, les suivants sont DUPLICATE.
-- Chaque scan est isolé : une erreur inattendue sur l'un n'annule pas les autres.
-- Retourne un tableau de résultats dans l'ordre d'envoi (champ "index").

create or replace function public.scan_batch(p_event_id uuid, p_staff_code text, p_scans jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_scan record;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  for v_scan in
    select s.value as val, (s.ordinality - 1)::int as idx
    from jsonb_array_elements(p_scans) with ordinality s
    order by (s.value ->> 'scannedAt')::timestamptz nulls last, s.ordinality
  loop
    begin
      v_result := public.scan_ticket(
        p_event_id,
        p_staff_code,
        v_scan.val ->> 'qrPayload',
        v_scan.val ->> 'deviceId',
        (v_scan.val ->> 'scannedAt')::timestamptz,
        v_scan.val ->> 'clientScanId',
        true
      );
    exception when others then
      v_result := jsonb_build_object('result', 'ERROR');
    end;
    v_results := v_results || jsonb_build_object('index', v_scan.idx, 'clientScanId', v_scan.val ->> 'clientScanId') || v_result;
  end loop;

  return coalesce((select jsonb_agg(r order by (r ->> 'index')::int) from jsonb_array_elements(v_results) r), '[]'::jsonb);
end;
$$;

revoke all on function public.scan_batch(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.scan_batch(uuid, text, jsonb) to service_role;
