BEGIN;
SET LOCAL lock_timeout='5s';
-- manual_assigned_to and its index are already created by 00-bootstrap-schema.sql

-- crm_infer_request_branches() is a BEST-EFFORT reconstruction -- the original
-- wilayat-to-branch geography mapping was in a private backup not present in
-- this repo. Only "Barka" wilayat routes to the barka branch; everything else
-- defaults to muscat. Correct this list once the real Barka-branch wilayat
-- set is known.
CREATE OR REPLACE FUNCTION public.crm_infer_request_branches(
  p_route_key text, p_branch_key text, p_wilayat text,
  p_preferred_area text, p_preferred_areas text[], p_alternative_areas text[]
) RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE v_areas text[]; v_result text[] := '{}'; v_a text;
BEGIN
  IF p_route_key = 'investment' OR p_branch_key = 'investment' THEN
    RETURN ARRAY['investment'];
  END IF;
  v_areas := ARRAY[coalesce(p_wilayat,''), coalesce(p_preferred_area,'')]
    || coalesce(p_preferred_areas,'{}'::text[]) || coalesce(p_alternative_areas,'{}'::text[]);
  FOREACH v_a IN ARRAY v_areas LOOP
    IF v_a ILIKE '%barka%' OR v_a ILIKE '%بركاء%' THEN
      v_result := array_append(v_result, 'barka');
    ELSIF v_a <> '' THEN
      v_result := array_append(v_result, 'muscat');
    END IF;
  END LOOP;
  v_result := ARRAY(SELECT DISTINCT unnest(v_result));
  RETURN v_result;
END;
$$;

ALTER TABLE public.client_request_assignees DROP CONSTRAINT client_request_assignees_branch_key_check;
ALTER TABLE public.client_request_assignees ADD CONSTRAINT client_request_assignees_branch_key_check
  CHECK(branch_key IN('muscat','barka','investment','general'));
CREATE FUNCTION crm_repair_private.guard_request_manual_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
BEGIN
  IF (TG_OP='INSERT' AND new.manual_assigned_to IS NOT NULL) OR
     (TG_OP='UPDATE' AND new.manual_assigned_to IS DISTINCT FROM old.manual_assigned_to) THEN
    IF auth.uid() IS NOT NULL AND (public.my_company() IS DISTINCT FROM new.company_id
      OR public.my_role() NOT IN('owner','manager')) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='manual_assignment_requires_manager';
    END IF;
    IF auth.uid() IS NULL AND current_user NOT IN('postgres','service_role','supabase_admin') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='manual_assignment_requires_manager';
    END IF;
  END IF;
  RETURN new;
END;
$$;
REVOKE ALL ON FUNCTION crm_repair_private.guard_request_manual_assignment() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER crm_guard_request_manual_assignment BEFORE INSERT OR UPDATE OF manual_assigned_to
  ON public.client_requests FOR EACH ROW EXECUTE FUNCTION crm_repair_private.guard_request_manual_assignment();
CREATE OR REPLACE FUNCTION public.crm_set_request_geography()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  branches text[];
  logical_route text;
  primary_route text;
  primary_user uuid;
begin
  branches := public.crm_infer_request_branches(new.route_key,new.branch_key,new.wilayat,new.preferred_area,new.preferred_areas,new.alternative_areas);

  if array_length(branches,1) is null then
    logical_route := 'general';
    primary_route := 'muscat';
  elsif array_length(branches,1)=1 then
    logical_route := branches[1];
    primary_route := branches[1];
  else
    logical_route := 'general';
    primary_route := 'muscat';
  end if;

  select r.assigned_to into primary_user
  from public.company_lead_routes r
  where r.company_id=new.company_id and r.route_key=primary_route and r.is_active=true
  limit 1;

  new.branch_key := logical_route;
  new.route_key := logical_route;
  IF new.manual_assigned_to IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=new.manual_assigned_to
      AND p.company_id=new.company_id AND p.is_active IS TRUE AND p.role IN('owner','manager','agent')) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='manual_assignee_not_active_in_company';
    END IF;
    new.assigned_to:=new.manual_assigned_to;
  ELSIF primary_user IS NOT NULL THEN new.assigned_to:=primary_user;
  END IF;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.crm_sync_request_assignees()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  branches text[];
  b text;
  uid uuid;
begin
  delete from public.client_request_assignees where request_id=new.id;

  if new.status in ('active','paused') then
    IF new.manual_assigned_to IS NOT NULL THEN
      insert into public.client_request_assignees(request_id,company_id,user_id,branch_key)
      values(new.id,new.company_id,new.manual_assigned_to,coalesce(new.branch_key,'general'))
      on conflict do nothing;
      perform public.crm_refresh_client_primary_assignment(new.company_id,new.client_id);
      return new;
    END IF;
    branches := public.crm_infer_request_branches(new.route_key,new.branch_key,new.wilayat,new.preferred_area,new.preferred_areas,new.alternative_areas);
    if array_length(branches,1) is null then branches:=array['muscat']::text[]; end if;

    foreach b in array branches loop
      select r.assigned_to into uid
      from public.company_lead_routes r
      where r.company_id=new.company_id and r.route_key=b and r.is_active=true
      limit 1;
      if uid is not null then
        insert into public.client_request_assignees(request_id,company_id,user_id,branch_key)
        values(new.id,new.company_id,uid,b)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  perform public.crm_refresh_client_primary_assignment(new.company_id,new.client_id);
  return new;
end;
$function$
;

DROP TRIGGER IF EXISTS trg_assign_request_geography ON public.client_requests;
CREATE TRIGGER trg_assign_request_geography BEFORE INSERT OR UPDATE OF route_key,branch_key,wilayat,
  preferred_area,preferred_areas,alternative_areas,status,manual_assigned_to ON public.client_requests
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_request_geography();
DROP TRIGGER IF EXISTS trg_sync_request_assignees ON public.client_requests;
CREATE TRIGGER trg_sync_request_assignees AFTER INSERT OR UPDATE OF route_key,branch_key,wilayat,
  preferred_area,preferred_areas,alternative_areas,status,assigned_to,manual_assigned_to ON public.client_requests
  FOR EACH ROW EXECUTE FUNCTION public.crm_sync_request_assignees();
COMMIT;
