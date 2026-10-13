-- Smart Group Tab — the kitchen chooses how the venue collects.
--
-- Only the venue's value changes. Sessions copy it when they open and read
-- their own copy from then on, so a table already seated is not affected.
-- 'hybrid' is not a choice here: nothing lets a table leave a prepaid balance
-- on purpose yet, so it would behave like pay_before_order.

create or replace function staff_set_service_mode(p_venue_id uuid, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current service_mode;
begin
  if p_mode is null or p_mode not in ('pay_before_order', 'open_tab') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_mode');
  end if;

  select default_service_mode into v_current from venues where id = p_venue_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown_venue');
  end if;

  if v_current::text = p_mode then
    return jsonb_build_object('status', 'unchanged', 'mode', p_mode);
  end if;

  update venues set default_service_mode = p_mode::service_mode where id = p_venue_id;
  perform staff_log('set_service_mode', p_venue_id, null,
                    jsonb_build_object('from', v_current, 'to', p_mode));
  return jsonb_build_object('status', 'updated', 'mode', p_mode, 'from', v_current);
end;
$$;

revoke all on function staff_set_service_mode(uuid, text) from public, anon, authenticated;
