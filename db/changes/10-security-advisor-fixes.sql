-- ============================================================================
-- Fixes for Supabase security advisor findings, run after edge-support-forward.sql.
-- ============================================================================

BEGIN;

-- ERROR: crm_properties_access/crm_deals_access were being evaluated with the
-- view owner's privileges rather than the querying user's, effectively
-- bypassing RLS on the underlying tables (their own WHERE-clause predicates
-- happened to compensate, but this closes the gap at the Postgres level too).
ALTER VIEW public.crm_properties_access SET (security_invoker = true);
ALTER VIEW public.crm_deals_access SET (security_invoker = true);

-- WARN: these SECURITY DEFINER functions are trigger-only or cron-only and
-- should never be callable directly via the public REST API. Trigger
-- execution does not require EXECUTE privilege on the trigger function, so
-- revoking these is safe and does not break the triggers that use them.
REVOKE EXECUTE ON FUNCTION public.crm_set_request_geography() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_sync_request_assignees() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_viewing_to_crm() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_due_whatsapp_followups(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_due_whatsapp_followups(integer) TO service_role;

COMMIT;

-- NOT fixed here (needs a Supabase dashboard change, not SQL):
-- Auth > Providers > Email > "Leaked password protection" is disabled.
-- Enable it at https://supabase.com/dashboard/project/_/auth/providers
