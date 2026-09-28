-- ============================================================================
-- Fix: "permission denied for table properties/deals" for every read through
-- crm_properties_access / crm_deals_access, introduced by
-- 10-security-advisor-fixes.sql (ALTER VIEW ... SET (security_invoker = true)).
--
-- With security_invoker on, the view's own query is evaluated with the
-- querying role's privileges. Both views internally reference financial
-- columns (owner_net/expected_commission on properties; company_commission,
-- agent_commission, commission_total, company_share, agent_share,
-- commission_status, broker_commission on deals) inside a
-- `CASE WHEN my_role()='owner' THEN col ELSE NULL END` expression to mask
-- them for non-owners. Evaluating that CASE still requires SELECT privilege
-- on the underlying column even though the value is nulled out for
-- non-owners, so authenticated/anon need column-level SELECT here.
--
-- This does NOT re-expose financial data: the view's CASE expression is the
-- actual masking mechanism and is unchanged. This grant only lets non-owner
-- roles evaluate the CASE (and get NULL back), matching the financial-02
-- lockdown's original intent.
-- ============================================================================

BEGIN;

GRANT SELECT (owner_net, expected_commission) ON public.properties TO authenticated, anon;

GRANT SELECT (
  company_commission, agent_commission, commission_total,
  company_share, agent_share, commission_status, broker_commission
) ON public.deals TO authenticated, anon;

COMMIT;
