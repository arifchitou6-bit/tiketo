-- TICKETO — accès staff (Phase 4) : code + PIN, sessions par jeton opaque.

-- Génère un nouveau code staff (6 caractères) + PIN (4 chiffres), retournés en clair une seule fois.
-- Le PIN est stocké haché (bcrypt). Les sessions ouvertes avec l'ancien code sont révoquées.
create or replace function public.rotate_staff_code(p_event_id uuid, p_organizer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
  v_code text;
  v_pin text;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found or v_event.organizer_id <> p_organizer_id then
    raise exception 'NOT_FOUND' using detail = 'Événement introuvable';
  end if;

  loop
    v_code := public.random_code(6);
    exit when not exists (select 1 from public.events where staff_code = v_code);
  end loop;
  -- 4 octets aléatoires -> entier positif -> 4 chiffres
  v_pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint & 2147483647) % 10000)::text, 4, '0');

  update public.events set staff_code = v_code where id = p_event_id;
  update public.event_secrets set staff_pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 8))
  where event_id = p_event_id;
  update public.staff_sessions set revoked_at = now() where event_id = p_event_id and revoked_at is null;

  return jsonb_build_object('code', v_code, 'pin', v_pin);
end;
$$;

-- Vérifie code + PIN et ouvre une session staff. Seule l'empreinte (sha256) du jeton est stockée.
create or replace function public.staff_login(p_code text, p_pin text, p_token_hash text, p_device_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.events;
  v_hash text;
  v_expires timestamptz;
begin
  select * into v_event from public.events where staff_code = upper(p_code);
  if found then
    select staff_pin_hash into v_hash from public.event_secrets where event_id = v_event.id;
  end if;
  -- Même message que le code soit inconnu ou le PIN faux : on ne révèle pas l'existence du code.
  if v_event.id is null or v_hash is null or extensions.crypt(p_pin, v_hash) <> v_hash then
    raise exception 'INVALID_CREDENTIALS' using detail = 'Code ou PIN incorrect';
  end if;
  if v_event.status = 'DRAFT' then
    raise exception 'EVENT_NOT_PUBLISHED' using detail = 'Cet événement n''est pas encore publié';
  end if;

  v_expires := greatest(v_event.ends_at, now()) + interval '12 hours';
  insert into public.staff_sessions (event_id, staff_code, token_hash, device_id, expires_at)
  values (v_event.id, v_event.staff_code, p_token_hash, p_device_id, v_expires);

  return jsonb_build_object(
    'eventId', v_event.id,
    'eventName', v_event.name,
    'venue', v_event.venue,
    'startsAt', v_event.starts_at,
    'endsAt', v_event.ends_at,
    'expiresAt', v_expires
  );
end;
$$;

revoke all on function public.rotate_staff_code(uuid, uuid) from public, anon, authenticated;
revoke all on function public.staff_login(text, text, text, text) from public, anon, authenticated;
grant execute on function public.rotate_staff_code(uuid, uuid) to service_role;
grant execute on function public.staff_login(text, text, text, text) to service_role;
