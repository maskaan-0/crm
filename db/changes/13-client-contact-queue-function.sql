-- ============================================================================
-- Fix: "Could not find the function public.crm_client_contact_queue(p_limit)
-- in the schema cache" — تعذر تحديث لوحة العمل (dashboard failed to refresh).
--
-- loadDashboard() and runFollowUpEngine() in app-base-v15.html both call
-- supa.rpc('crm_client_contact_queue',{p_limit:2000}) expecting rows shaped
-- {client_id, client_name, phone, oldest_pending_at} representing clients
-- who have never been contacted by staff. This function was never defined
-- anywhere in the migration history (it's one of the pieces referenced only
-- from the private backup mentioned in db/changes/README.md).
--
-- Definition used here: a client counts as "uncontacted" while
-- clients.human_contact_at IS NULL (staff has never logged a human contact)
-- and they are not follow-up-suppressed/archived. oldest_pending_at is the
-- earliest of the client's own created_at and any of their active
-- client_requests still waiting on a first human response, so the "waiting
-- since" age shown on the dashboard reflects whichever came first.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.crm_client_contact_queue(p_limit integer DEFAULT 500)
RETURNS TABLE (
  client_id uuid,
  client_name text,
  phone text,
  oldest_pending_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = 'pg_catalog', 'public'
AS $function$
  SELECT
    c.id,
    c.name,
    c.phone,
    LEAST(c.created_at, COALESCE(MIN(r.created_at), c.created_at)) AS oldest_pending_at
  FROM public.clients c
  LEFT JOIN public.client_requests r
    ON r.client_id = c.id
   AND r.status = 'active'
   AND r.first_human_response_at IS NULL
  WHERE c.company_id = public.my_company()
    AND c.archived IS NOT TRUE
    AND c.human_contact_at IS NULL
    AND COALESCE(c.followup_suppressed, false) = false
  GROUP BY c.id, c.name, c.phone, c.created_at
  ORDER BY oldest_pending_at ASC
  LIMIT p_limit
$function$;

GRANT EXECUTE ON FUNCTION public.crm_client_contact_queue(integer) TO authenticated;

COMMIT;
