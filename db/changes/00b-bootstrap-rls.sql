-- ============================================================================
-- DRAFT base RLS policy layer + crm_refresh_client_primary_assignment()
-- Written because db/changes/01-security.forward.sql uses ALTER POLICY on
-- policies (and a function) that were never in this repo -- they lived in
-- an original schema/policy set the README calls a "private backup" that
-- is not available. This reconstructs a reasonable baseline from the app's
-- role model (owner/manager/agent/viewer, company-scoped) so 01-security's
-- ALTER POLICY statements have something to alter, and so RLS is not left
-- fully open in the meantime.
--
-- STATUS: DRAFT. Role/ownership assumptions per table are reasonable
-- defaults, not verified against original policy text (which no longer
-- exists). Tighten further once the app is exercised end-to-end.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Function assumed pre-existing by 01-security.forward.sql (REVOKE/GRANT only,
-- no CREATE). Reconstructed: recompute a client's primary assigned agent from
-- their most recently active client_request assignment. Trigger-only, no
-- direct client-facing write path (matches 01-security's comment).
-- ----------------------------------------------------------------------------
-- Parameter order is (company_id, client_id) to match how 07-manual-assignment.forward.sql
-- calls it (perform public.crm_refresh_client_primary_assignment(new.company_id,new.client_id)).
CREATE OR REPLACE FUNCTION public.crm_refresh_client_primary_assignment(p_company_id uuid, p_client_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_agent uuid;
BEGIN
  SELECT COALESCE(r.manual_assigned_to, r.assigned_to) INTO v_agent
  FROM public.client_requests r
  WHERE r.client_id = p_client_id AND r.company_id = p_company_id
    AND r.status IN ('active','paused')
  ORDER BY r.updated_at DESC NULLS LAST, r.created_at DESC
  LIMIT 1;

  UPDATE public.clients
  SET assigned_to = v_agent, updated_at = now()
  WHERE id = p_client_id AND company_id = p_company_id
    AND assigned_to IS DISTINCT FROM v_agent;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_refresh_client_primary_assignment(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_refresh_client_primary_assignment(uuid,uuid) TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Enable RLS everywhere
-- ----------------------------------------------------------------------------
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_request_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viewings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_lead_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rejection_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_marketing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_rejection_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_action_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_monthly_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unmatched_property_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_message_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_followup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_followup_optins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_followup_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_template_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_automation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_request_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_message_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_send_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_outbound_operations ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- companies: members can see their own company; only owner can update it
-- ----------------------------------------------------------------------------
CREATE POLICY companies_select_own ON public.companies FOR SELECT TO authenticated
USING (id = (SELECT public.my_company()));
CREATE POLICY companies_update_owner ON public.companies FOR UPDATE TO authenticated
USING (id = (SELECT public.my_company()) AND (SELECT public.my_role()) = 'owner')
WITH CHECK (id = (SELECT public.my_company()) AND (SELECT public.my_role()) = 'owner');

-- ----------------------------------------------------------------------------
-- profiles: see teammates in your company; only owner/manager manage others;
-- everyone can update their own row (non-role fields; role/company changes
-- should go through invite/admin flows, not enforced at RLS granularity here)
-- ----------------------------------------------------------------------------
CREATE POLICY profiles_select_company ON public.profiles FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) OR id = (SELECT auth.uid()));
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated
USING (id = (SELECT auth.uid()) OR (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager')))
WITH CHECK (id = (SELECT auth.uid()) OR (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager')));

-- ----------------------------------------------------------------------------
-- Generic "owner/manager full access within company" + "agent sees own +
-- company reads where relevant" pattern applied per table below.
-- ----------------------------------------------------------------------------

-- owners (property owners/brokers)
CREATE POLICY owners_staff_select ON public.owners FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY owners_admin_write ON public.owners FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));
CREATE POLICY owners_agent_insert ON public.owners FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) = 'agent' AND added_by = (SELECT auth.uid()));

-- clients
CREATE POLICY clients_select_scoped ON public.clients FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager','viewer') OR assigned_to = (SELECT auth.uid())));
CREATE POLICY clients_insert_staff ON public.clients FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager','agent'));
CREATE POLICY clients_update_scoped ON public.clients FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR assigned_to = (SELECT auth.uid())))
WITH CHECK (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR assigned_to = (SELECT auth.uid())));

-- deals (financial-ish; owner/manager full, assigned agent read+update own)
CREATE POLICY deals_select_scoped ON public.deals FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR agent_id = (SELECT auth.uid())));
CREATE POLICY deals_admin_write ON public.deals FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));
CREATE POLICY deals_agent_update_own ON public.deals FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()) AND agent_id = (SELECT auth.uid()))
WITH CHECK (company_id = (SELECT public.my_company()) AND agent_id = (SELECT auth.uid()));

-- properties (financial fields owner_net/expected_commission locked down
-- separately by financial-02-financial-lockdown.forward.sql via column GRANT)
CREATE POLICY properties_select_company ON public.properties FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY properties_insert_staff ON public.properties FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager','agent'));
CREATE POLICY properties_update_scoped ON public.properties FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR added_by = (SELECT auth.uid())))
WITH CHECK (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR added_by = (SELECT auth.uid())));

-- client_requests
CREATE POLICY client_requests_select_scoped ON public.client_requests FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager','viewer') OR assigned_to = (SELECT auth.uid()) OR
   EXISTS(SELECT 1 FROM public.client_request_assignees a WHERE a.request_id = client_requests.id AND a.user_id = (SELECT auth.uid()))));
CREATE POLICY client_requests_insert_staff ON public.client_requests FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager','agent'));
CREATE POLICY client_requests_update_scoped ON public.client_requests FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR assigned_to = (SELECT auth.uid())))
WITH CHECK (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR assigned_to = (SELECT auth.uid())));

-- client_request_assignees (junction, trigger-maintained; read-only to staff)
CREATE POLICY client_request_assignees_select ON public.client_request_assignees FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));

-- viewings: base policies matching the exact names/command-types
-- 01-security.forward.sql will ALTER POLICY on (its USING/WITH CHECK there
-- supersede these bodies once applied)
CREATE POLICY viewings_select_company ON public.viewings FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY viewings_insert_staff ON public.viewings FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()));
CREATE POLICY viewings_update_staff ON public.viewings FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()))
WITH CHECK (company_id = (SELECT public.my_company()));

-- tasks
CREATE POLICY tasks_select_scoped ON public.tasks FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager','viewer') OR user_id = (SELECT auth.uid())));
CREATE POLICY tasks_write_scoped ON public.tasks FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR user_id = (SELECT auth.uid())))
WITH CHECK (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR user_id = (SELECT auth.uid())));

-- events
CREATE POLICY events_select_scoped ON public.events FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager','viewer') OR user_id = (SELECT auth.uid())));
CREATE POLICY events_write_scoped ON public.events FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR user_id = (SELECT auth.uid())))
WITH CHECK (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR user_id = (SELECT auth.uid())));

-- expenses & deposits: financial, owner/manager only
CREATE POLICY expenses_admin_only ON public.expenses FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));
CREATE POLICY deposits_admin_only ON public.deposits FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- company_invites: owner/manager only
CREATE POLICY company_invites_admin_only ON public.company_invites FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- company_lead_routes: staff read, owner/manager manage
CREATE POLICY company_lead_routes_select ON public.company_lead_routes FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY company_lead_routes_admin_write ON public.company_lead_routes FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- rejection_reasons: global catalog readable by all staff; owner/manager manage
CREATE POLICY rejection_reasons_select ON public.rejection_reasons FOR SELECT TO authenticated
USING (company_id IS NULL OR company_id = (SELECT public.my_company()));
CREATE POLICY rejection_reasons_admin_write ON public.rejection_reasons FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- property_marketing_events: staff read/write company-wide (marketing, not sensitive)
CREATE POLICY property_marketing_events_staff ON public.property_marketing_events FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()))
WITH CHECK (company_id = (SELECT public.my_company()));

-- property_inquiries
CREATE POLICY property_inquiries_select_scoped ON public.property_inquiries FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager','viewer') OR assigned_to = (SELECT auth.uid())));
CREATE POLICY property_inquiries_write_scoped ON public.property_inquiries FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR assigned_to = (SELECT auth.uid())))
WITH CHECK (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR assigned_to = (SELECT auth.uid())));

-- property_rejection_reasons: follow inquiry access, staff company-wide is fine (low sensitivity)
CREATE POLICY property_rejection_reasons_staff ON public.property_rejection_reasons FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()))
WITH CHECK (company_id = (SELECT public.my_company()));

-- property_action_reviews: owner/manager only (decision log)
CREATE POLICY property_action_reviews_admin_only ON public.property_action_reviews FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- measurement_periods / measurement_targets: owner/manager manage, staff read
CREATE POLICY measurement_periods_select ON public.measurement_periods FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY measurement_periods_admin_write ON public.measurement_periods FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));
CREATE POLICY measurement_targets_select ON public.measurement_targets FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY measurement_targets_admin_write ON public.measurement_targets FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- employee_monthly_targets: owner/manager manage; employee can read their own
CREATE POLICY employee_monthly_targets_select ON public.employee_monthly_targets FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()) AND
  ((SELECT public.my_role()) IN ('owner','manager') OR employee_id = (SELECT auth.uid())));
CREATE POLICY employee_monthly_targets_admin_write ON public.employee_monthly_targets FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- whatsapp_messages / whatsapp_conversations: base SELECT-only policies with
-- names 01-security expects; writes are service_role only (webhook/edge
-- functions bypass RLS), so no INSERT/UPDATE/DELETE policy for authenticated.
CREATE POLICY whatsapp_conversations_select_by_role ON public.whatsapp_conversations FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY whatsapp_messages_select_by_role ON public.whatsapp_messages FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
-- allow staff to update conversation assignment/status fields directly
CREATE POLICY whatsapp_conversations_update_staff ON public.whatsapp_conversations FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager','agent'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager','agent'));

-- unmatched_property_links: staff read; writes via RPC (revoked below)
CREATE POLICY unmatched_property_links_select ON public.unmatched_property_links FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
REVOKE INSERT, UPDATE, DELETE ON public.unmatched_property_links FROM authenticated;

-- appointments: base policies matching names 01-security expects
CREATE POLICY appointments_select_allowed ON public.appointments FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY appointments_insert_allowed ON public.appointments FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()));
CREATE POLICY appointments_update_allowed ON public.appointments FOR UPDATE TO authenticated
USING (company_id = (SELECT public.my_company()))
WITH CHECK (company_id = (SELECT public.my_company()));

-- appointment_properties: follow parent appointment
CREATE POLICY appointment_properties_select ON public.appointment_properties FOR SELECT TO authenticated
USING (EXISTS(SELECT 1 FROM public.appointments ap WHERE ap.id = appointment_properties.appointment_id
  AND ap.company_id = (SELECT public.my_company())));

-- whatsapp_message_requests: base select policy matching name 01-security expects
CREATE POLICY whatsapp_message_requests_select_allowed ON public.whatsapp_message_requests FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));

-- whatsapp_followup_events/optins/optouts: automation-only, no authenticated policies
-- (RLS enabled with zero policies = blocked for authenticated/anon; service_role bypasses RLS)

-- whatsapp_template_registry: staff read, owner/manager manage
CREATE POLICY whatsapp_template_registry_select ON public.whatsapp_template_registry FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY whatsapp_template_registry_admin_write ON public.whatsapp_template_registry FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- deal_stage_history: base select policy + an insert policy that 01-security
-- immediately drops (trigger-only writes thereafter)
CREATE POLICY deal_stage_history_select_company ON public.deal_stage_history FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY deal_stage_history_insert_company ON public.deal_stage_history FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()));

-- whatsapp_automation_events: automation-only, no authenticated policies

-- client_request_events: base select policy matching name 01-security expects
CREATE POLICY client_request_events_select_allowed ON public.client_request_events FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));

-- notifications: base policies matching the exact (quoted) names 01-security expects
CREATE POLICY "Own notifications only" ON public.notifications FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Update own notifications" ON public.notifications FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY notifications_insert_own ON public.notifications FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

-- instagram_accounts: owner/manager only (holds credential pointers)
CREATE POLICY instagram_accounts_admin_only ON public.instagram_accounts FOR ALL TO authenticated
USING (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'))
WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.my_role()) IN ('owner','manager'));

-- instagram_conversations / instagram_messages: staff read company-wide, no
-- direct authenticated writes (service_role/edge functions write)
CREATE POLICY instagram_conversations_select ON public.instagram_conversations FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY instagram_messages_select ON public.instagram_messages FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));

-- property_message_attributions: staff read company-wide
CREATE POLICY property_message_attributions_select ON public.property_message_attributions FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));

-- whatsapp_send_operations / instagram_outbound_operations: automation-only,
-- no authenticated policies (idempotency ledgers for edge functions)

COMMIT;
