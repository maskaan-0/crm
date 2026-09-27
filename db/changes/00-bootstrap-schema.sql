-- ============================================================================
-- DRAFT bootstrap schema for Maskaan_0 CRM (Supabase project dmsckqjkcnsfmnzfjczz)
-- Generated 2026-09-27 by reverse-engineering app-base-v15.html, crm-*.js,
-- supabase/functions/*, and db/changes/*.forward.sql (which are PATCHES that
-- assume this base schema already exists -- they must be run AFTER this file).
--
-- STATUS: DRAFT FOR REVIEW. Do not run against production until confirmed.
-- Column types/constraints for the 24 app-facing tables are high-confidence
-- (cross-checked against CRM_EXPORT_MANIFEST + code). The ~16 supporting
-- tables (deals, appointments, whatsapp_messages, instagram_*, notifications,
-- etc.) are lower-confidence: named/FK'd by triggers and code but their full
-- column lists were not exhaustively extracted. Marked with [VERIFY].
--
-- ORDER OF OPERATIONS FOR FULL BOOTSTRAP (verified end-to-end 2026-09-27
-- against project bdllokupbezfqupinzsf):
--   1. This file (00-bootstrap-schema.sql) -- includes seeding rejection_reasons
--   2. db/changes/00b-bootstrap-rls.sql
--   3. db/changes/01-security.forward.sql  through  08-storage.forward.sql (in numeric order)
--   4. db/changes/09-schema-gap-fixes.sql -- REQUIRED: columns/tables/functions
--      the files below assume already exist but that this reconstructed
--      bootstrap didn't originally include; discovered by actually running
--      each file against a live database
--   5. db/changes/financial-01-financial-views.forward.sql, financial-02-financial-lockdown.forward.sql
--   6. db/changes/conversation-forward.sql, conversation-sequence-backfill.sql, conversation-cutover-guard.sql
--   7. db/changes/instagram-conversation-forward.sql, instagram-send-forward.sql
--   8. db/changes/funnel-forward.sql, funnel-metrics.sql
--   9. db/changes/edge-support-forward.sql
--  10. db/changes/10-security-advisor-fixes.sql
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. companies (tenant root)
-- ============================================================================
CREATE TABLE public.companies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL,
  license_number              text,
  cr_number                   text,
  phone                       text,
  email                       text,
  address                     text,
  logo_url                    text,
  default_company_commission  numeric,
  default_agent_commission    numeric,
  gsheet_url                  text,
  gsheet_last_sync            timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. profiles (1:1 with auth.users)
-- ============================================================================
CREATE TABLE public.profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES public.companies(id),
  full_name       text,
  email           text UNIQUE,
  phone           text,
  role            text NOT NULL DEFAULT 'agent' CHECK (role IN ('owner','manager','agent','viewer')),
  commission_rate numeric,
  avatar_url      text,
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz
);
CREATE INDEX profiles_company_id_idx ON public.profiles(company_id);

-- ============================================================================
-- Helper functions (normally in db/changes/01-security.forward.sql, created
-- here early because many CHECK/trigger defs below may reference them)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.my_company()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT p.company_id FROM public.profiles p
       WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE $$;

CREATE OR REPLACE FUNCTION public.my_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT p.role FROM public.profiles p
       WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE $$;

REVOKE ALL ON FUNCTION public.my_company(), public.my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_company(), public.my_role() TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS crm_repair_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA crm_repair_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA crm_repair_private TO authenticated, service_role;

-- ============================================================================
-- 3. owners (property owners / brokers / agencies)
-- ============================================================================
CREATE TABLE public.owners (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES public.companies(id),
  added_by           uuid REFERENCES public.profiles(id),
  name               text NOT NULL,
  phone              text,
  email              text,
  nationality        text,
  id_number          text,
  owner_type         text NOT NULL DEFAULT 'owner' CHECK (owner_type IN ('owner','broker','agency')),
  exclusive          boolean,
  terms              text,
  address            text,
  notes              text,
  archived           boolean NOT NULL DEFAULT false,
  rating             smallint,
  relationship_type  text,
  responsive         boolean,
  multiple_brokers   boolean,
  total_revenue      numeric,
  successful_deals   integer,
  failed_deals       integer,
  commission_rate    numeric,
  last_contact       timestamptz,
  next_followup      date,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owners_company_id_idx ON public.owners(company_id);

-- ============================================================================
-- 4. clients
-- ============================================================================
CREATE TABLE public.clients (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES public.companies(id),
  assigned_to                 uuid REFERENCES public.profiles(id),
  name                        text NOT NULL,
  phone                       text,
  phone_normalized            text,
  email                       text,
  client_type                 text,
  is_buyer                    boolean NOT NULL DEFAULT false,
  is_seller                   boolean NOT NULL DEFAULT false,
  is_investor                 boolean NOT NULL DEFAULT false,
  source                      text,
  preferred_area              text,
  property_type               text,
  budget_min                  numeric,
  budget_max                  numeric,
  status                      text,
  pipeline_stage              text DEFAULT 'new',
  notes                       text,
  tags                        text[],
  importance                  smallint,
  readiness                   text,
  lead_score                  integer,
  lead_temperature            text,
  lead_route                  text,
  inbound_number              text,
  next_followup               date,
  last_contact_at             timestamptz,
  human_contact_at            timestamptz,
  followup_suppressed         boolean NOT NULL DEFAULT false,
  followup_suppressed_reason  text,
  followup_suppressed_at      timestamptz,
  followup_suppressed_by      uuid REFERENCES public.profiles(id),
  last_ai_profile             jsonb,
  last_ai_profile_at          timestamptz,
  instagram_participant_id    text,
  nationality                 text,
  country                     text,
  wilayat                     text,
  payment_method              text,
  purchase_timing             text,
  purpose                     text,
  archived                    boolean NOT NULL DEFAULT false,
  archived_at                 timestamptz,
  archived_by                 uuid REFERENCES public.profiles(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz,
  CONSTRAINT crm_clients_budget_valid CHECK (
    (budget_min IS NULL OR budget_min >= 0) AND
    (budget_max IS NULL OR budget_max >= 0) AND
    (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)
  )
);
CREATE INDEX clients_company_id_idx ON public.clients(company_id);
CREATE INDEX clients_assigned_to_idx ON public.clients(assigned_to);
CREATE UNIQUE INDEX clients_company_phone_uidx ON public.clients(company_id, phone_normalized) WHERE phone_normalized IS NOT NULL;

-- ============================================================================
-- 5. deals [VERIFY] -- out-of-scope table, referenced heavily by triggers/FKs
--    below (tasks.deal_id, deposits.deal_id, properties status-guard trigger)
-- ============================================================================
CREATE TABLE public.deals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id),
  client_id        uuid REFERENCES public.clients(id),
  property_id      uuid,  -- FK added after properties table created below
  agent_id         uuid REFERENCES public.profiles(id),
  stage            text NOT NULL DEFAULT 'open',
  sale_price       numeric,
  commission_total numeric,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','cancelled')),
  closed_at        timestamptz,
  notes            text,
  created_by       uuid REFERENCES public.profiles(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz
);
CREATE INDEX deals_company_id_idx ON public.deals(company_id);

-- ============================================================================
-- 6. properties
-- ============================================================================
CREATE TABLE public.properties (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL REFERENCES public.companies(id),
  added_by                        uuid REFERENCES public.profiles(id),
  owner_id                        uuid REFERENCES public.owners(id),
  owner_client_id                 uuid REFERENCES public.clients(id),
  property_code                   text,
  internal_name                   text,
  title                           text NOT NULL,
  type                            text,
  area                            text,
  wilayat                         text,
  branch_key                      text,
  price                           numeric,
  bedrooms                        integer,
  bathrooms                       integer,
  land_size                       numeric,
  built_size                      numeric,
  status                          text NOT NULL DEFAULT 'available',
  description                     text,
  public_details                  text,
  map_url                         text,
  images                          jsonb NOT NULL DEFAULT '[]'::jsonb,
  views_count                     integer NOT NULL DEFAULT 0,
  inquiries_count                 integer NOT NULL DEFAULT 0,
  source_type                     text,
  marketing_status                text,
  marketing_review_status         text,
  marketing_reviewed_at           timestamptz,
  marketing_review_note           text,
  photography_status              text,
  photography_reason              text,
  photography_required_at         timestamptz,
  photography_completed_at        timestamptz,
  availability_checked_at         timestamptz,
  performance_tracking_started_at timestamptz,
  last_ai_recommendation          jsonb,
  last_ai_recommendation_at       timestamptz,
  has_listing_agreement           boolean NOT NULL DEFAULT false,
  agreement_start_date            date,
  agreement_duration_months       integer,
  agreement_end_date              date,
  agreement_reminder_days         integer,
  owner_net                       numeric,          -- owner-role-only, see financial-02 lockdown
  expected_commission             numeric,          -- owner-role-only, see financial-02 lockdown
  archived                        boolean NOT NULL DEFAULT false,
  archived_at                     timestamptz,
  archived_by                     uuid REFERENCES public.profiles(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz,
  CONSTRAINT crm_properties_numbers_valid CHECK (
    (price IS NULL OR price >= 0) AND (owner_net IS NULL OR owner_net >= 0) AND
    (land_size IS NULL OR land_size >= 0) AND (built_size IS NULL OR built_size >= 0) AND
    (bedrooms IS NULL OR bedrooms >= 0) AND (bathrooms IS NULL OR bathrooms >= 0)
  )
);
CREATE INDEX properties_company_id_idx ON public.properties(company_id);
ALTER TABLE public.deals ADD CONSTRAINT deals_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);

-- ============================================================================
-- 7. client_requests
-- ============================================================================
CREATE TABLE public.client_requests (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL REFERENCES public.companies(id),
  client_id                       uuid NOT NULL REFERENCES public.clients(id),
  request_type                    text,
  property_type                   text,
  property_types                  text[],
  preferred_area                  text,
  preferred_areas                 text[],
  alternative_areas               text[],
  wilayat                         text,
  budget_min                      numeric,
  budget_max                      numeric,
  payment_method                  text,
  purchase_timing                 text,
  purpose                         text,
  bedrooms_min                    integer,
  bathrooms_min                   integer,
  land_size_min                   numeric,
  land_size_max                   numeric,
  built_size_min                  numeric,
  built_size_max                  numeric,
  furnished                       text,
  must_haves                      jsonb,
  flexible_preferences            jsonb,
  financing_readiness             text,
  decision_maker_status           text,
  status                          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','won','lost','cancelled','archived')),
  pipeline_stage                  text,
  search_status                   text,
  next_action                     text,
  priority                        text,
  next_followup                   date,
  followup_note                   text,
  last_contact_at                 timestamptz,
  last_mutual_contact_at          timestamptz,
  source                          text,
  source_detail                   text,
  assigned_to                     uuid REFERENCES public.profiles(id),
  manual_assigned_to              uuid REFERENCES public.profiles(id),
  route_key                       text,
  branch_key                      text,
  inbound_number                  text,
  subject_property_id             uuid REFERENCES public.properties(id),
  created_via                     text,
  origin_whatsapp_message_id      uuid,  -- FK added once whatsapp_messages exists
  ai_confidence                   numeric,
  ai_extracted                    jsonb,
  needs_human_review              boolean NOT NULL DEFAULT false,
  lead_score                      integer,
  lead_temperature                text,
  notes                           text,
  closed_reason                   text,
  closed_at                       timestamptz,
  is_first_request                boolean,
  first_human_response_at         timestamptz,
  first_mutual_dialogue_at        timestamptz,
  requirements_completed_at       timestamptz,
  qualified_at                    timestamptz,
  first_match_sent_at             timestamptz,
  first_appointment_booked_at     timestamptz,
  first_appointment_confirmed_at  timestamptz,
  first_attended_at               timestamptz,
  serious_interest_at             timestamptz,
  opportunity_opened_at           timestamptz,
  negotiation_started_at          timestamptz,
  deposit_paid_at                 timestamptz,
  contract_completed_at           timestamptz,
  closed_won_at                   timestamptz,
  missing_required_fields         text[],
  last_requirements_prompt_at     timestamptz,
  last_requirements_prompt_fields text[],
  requirements_prompt_count       integer NOT NULL DEFAULT 0,
  created_by                      uuid REFERENCES public.profiles(id),
  updated_by                      uuid REFERENCES public.profiles(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz
);
CREATE INDEX client_requests_company_id_idx ON public.client_requests(company_id);
CREATE INDEX client_requests_client_id_idx ON public.client_requests(client_id);
CREATE INDEX client_requests_manual_assigned_to_fk_idx ON public.client_requests(manual_assigned_to) WHERE manual_assigned_to IS NOT NULL;

-- ============================================================================
-- 8. client_request_assignees
-- ============================================================================
CREATE TABLE public.client_request_assignees (
  request_id  uuid NOT NULL REFERENCES public.client_requests(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES public.companies(id),
  user_id     uuid NOT NULL REFERENCES public.profiles(id),
  branch_key  text NOT NULL CHECK (branch_key IN ('muscat','barka','investment','general')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id, branch_key)
);

-- ============================================================================
-- 9. viewings
-- ============================================================================
CREATE TABLE public.viewings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES public.companies(id),
  client_id                 uuid NOT NULL REFERENCES public.clients(id),
  property_id               uuid NOT NULL REFERENCES public.properties(id),
  agent_id                  uuid REFERENCES public.profiles(id),
  request_id                uuid REFERENCES public.client_requests(id),
  appointment_id            uuid,  -- FK added once appointments exists
  viewing_date              date,
  viewing_time              time,
  duration_minutes          integer CHECK (duration_minutes BETWEEN 1 AND 1440),
  location                  text,
  status                    text NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','confirmed','done','cancelled','no_show','postponed')),
  attendance                text,
  client_feedback           text,
  rejection_reason          text,
  liked                     boolean,
  next_step                 text,
  followup_date             date,
  notes                     text,
  pipeline_outcome          text,
  outcome_note              text,
  created_via               text DEFAULT 'manual',
  source_whatsapp_message_id uuid,  -- FK added once whatsapp_messages exists
  auto_confidence           numeric,
  archived                  boolean NOT NULL DEFAULT false,
  row_version                bigint NOT NULL DEFAULT 1,
  updated_at                 timestamptz DEFAULT now(),
  created_by                uuid REFERENCES public.profiles(id),
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX viewings_company_id_idx ON public.viewings(company_id);
CREATE INDEX viewings_client_id_idx ON public.viewings(client_id);
CREATE INDEX viewings_property_id_idx ON public.viewings(property_id);

-- ============================================================================
-- 10. tasks
-- ============================================================================
CREATE TABLE public.tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id),
  user_id       uuid REFERENCES public.profiles(id),
  client_id     uuid REFERENCES public.clients(id),
  deal_id       uuid REFERENCES public.deals(id),
  request_id    uuid REFERENCES public.client_requests(id),
  viewing_id    uuid REFERENCES public.viewings(id) ON DELETE SET NULL,
  title         text NOT NULL,
  notes         text,
  due_date      date,
  priority      text DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  done          boolean NOT NULL DEFAULT false,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_one_open_viewing_followup ON public.tasks(company_id, viewing_id)
  WHERE viewing_id IS NOT NULL AND done IS FALSE;
CREATE INDEX crm_tasks_viewing_fk_idx ON public.tasks(viewing_id) WHERE viewing_id IS NOT NULL;
CREATE INDEX tasks_company_id_idx ON public.tasks(company_id);

-- ============================================================================
-- 11. events (calendar)
-- ============================================================================
CREATE TABLE public.events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id),
  user_id           uuid REFERENCES public.profiles(id),
  client_id         uuid REFERENCES public.clients(id),
  title             text NOT NULL,
  type              text,
  event_date        date,
  event_time        time,
  duration_minutes  integer DEFAULT 60,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_company_id_idx ON public.events(company_id);

-- ============================================================================
-- 12. expenses
-- ============================================================================
CREATE TABLE public.expenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id),
  user_id        uuid REFERENCES public.profiles(id),
  description    text,
  category       text CHECK (category IN ('rent','marketing','photography','fuel','salary','communications','hospitality','subscriptions','other')),
  amount         numeric NOT NULL,
  expense_date   date,
  payment_method text,
  notes          text,
  archived       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_company_id_idx ON public.expenses(company_id);

-- ============================================================================
-- 13. deposits
-- ============================================================================
CREATE TABLE public.deposits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id),
  deal_id        uuid REFERENCES public.deals(id),
  client_id      uuid REFERENCES public.clients(id),
  property_id    uuid REFERENCES public.properties(id),
  amount         numeric NOT NULL,
  payment_method text,
  payment_date   date,
  received_by    text,
  refundable     text,
  duration_days  integer DEFAULT 30,
  expiry_date    date,
  extension_days integer,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','applied','refunded','forfeited')),
  contract_url   text,
  receipt_url    text,
  legal_notes    text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deposits_company_id_idx ON public.deposits(company_id);
CREATE INDEX deposits_deal_id_idx ON public.deposits(deal_id);

-- ============================================================================
-- 14. company_invites
-- ============================================================================
CREATE TABLE public.company_invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  email      text NOT NULL,
  token      text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  role       text NOT NULL DEFAULT 'agent' CHECK (role IN ('owner','manager','agent','viewer')),
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','revoked','used','expired')),
  created_by uuid REFERENCES public.profiles(id),
  used_by    uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  used_at    timestamptz
);
CREATE UNIQUE INDEX company_invites_pending_email ON public.company_invites(company_id, email) WHERE status = 'pending';

-- ============================================================================
-- 15. company_lead_routes
-- ============================================================================
CREATE TABLE public.company_lead_routes (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES public.companies(id),
  route_key                     text NOT NULL,
  label                         text,
  assigned_to                   uuid REFERENCES public.profiles(id),
  whatsapp_number               text,
  meta_phone_number_id          text,
  meta_waba_id                  text,
  meta_login_configuration_id   text,
  channel_type                  text,
  owner_only_inbox              boolean NOT NULL DEFAULT false,
  is_active                     boolean NOT NULL DEFAULT true,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz,
  UNIQUE (company_id, route_key)
);

-- ============================================================================
-- 16. rejection_reasons (global catalog, company_id nullable)
-- ============================================================================
CREATE TABLE public.rejection_reasons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id),
  code       text NOT NULL,
  label_ar   text,
  category   text,
  is_active  boolean NOT NULL DEFAULT true,
  sort_order integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 17. property_marketing_events
-- ============================================================================
CREATE TABLE public.property_marketing_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES public.companies(id),
  property_id          uuid NOT NULL REFERENCES public.properties(id),
  channel              text CHECK (channel IN ('instagram','youtube','other','whatsapp')),
  event_type           text CHECK (event_type IN ('publish','update','install','remove','other')),
  published_at         timestamptz,
  url                  text,
  link_key             text,
  link_provider        text,
  instagram_media_id   text,
  views                integer DEFAULT 0,
  reach                integer DEFAULT 0,
  likes                integer DEFAULT 0,
  comments             integer DEFAULT 0,
  shares               integer DEFAULT 0,
  saves                integer DEFAULT 0,
  total_interactions   integer DEFAULT 0,
  plays                integer DEFAULT 0,
  watch_time_ms        bigint,
  avg_watch_time_ms    bigint,
  replays              integer,
  auto_sync            boolean NOT NULL DEFAULT false,
  sync_status          text DEFAULT 'manual',
  last_synced_at       timestamptz,
  sync_error           text,
  notes                text,
  created_by           uuid REFERENCES public.profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX property_marketing_events_company_link_uidx ON public.property_marketing_events(company_id, link_key) WHERE link_key IS NOT NULL;

-- ============================================================================
-- 18. property_inquiries
-- ============================================================================
CREATE TABLE public.property_inquiries (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES public.companies(id),
  client_id                   uuid NOT NULL REFERENCES public.clients(id),
  property_id                 uuid NOT NULL REFERENCES public.properties(id),
  request_id                  uuid REFERENCES public.client_requests(id),
  assigned_to                 uuid REFERENCES public.profiles(id),
  marketing_event_id          uuid REFERENCES public.property_marketing_events(id),
  source_whatsapp_message_id  uuid,  -- FK added once whatsapp_messages exists, ON DELETE SET NULL
  source                      text CHECK (source IN ('whatsapp','instagram','oman_reel','youtube','signboard','referral','website','other')),
  source_detail                text,
  source_url                   text,
  campaign_name                text,
  ad_name                      text,
  status                       text DEFAULT 'inquiry',
  match_status                 text,
  match_notes                  text,
  client_response               text,
  is_first_attraction          boolean,
  shown_by_agent                boolean NOT NULL DEFAULT false,
  has_inbound_inquiry           boolean NOT NULL DEFAULT false,
  viewing_booked                boolean,
  viewing_completed             boolean,
  post_visit_interest           text,
  outcome                       text,
  rejection_reason              text,
  rejection_notes               text,
  last_message                  text,
  inquiry_count                  integer NOT NULL DEFAULT 1,
  first_inquiry_at               timestamptz,
  last_inquiry_at                timestamptz,
  last_contact_at                timestamptz,
  next_followup                  date,
  followup_note                  text,
  created_by                     uuid REFERENCES public.profiles(id),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz
);
CREATE INDEX property_inquiries_company_id_idx ON public.property_inquiries(company_id);
CREATE INDEX property_inquiries_client_id_idx ON public.property_inquiries(client_id);
CREATE INDEX property_inquiries_property_id_idx ON public.property_inquiries(property_id);

-- ============================================================================
-- 19. property_rejection_reasons
-- ============================================================================
CREATE TABLE public.property_rejection_reasons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id),
  property_inquiry_id uuid REFERENCES public.property_inquiries(id),
  client_id           uuid REFERENCES public.clients(id),
  request_id          uuid REFERENCES public.client_requests(id),
  property_id         uuid REFERENCES public.properties(id),
  reason_id           uuid NOT NULL REFERENCES public.rejection_reasons(id),
  is_primary          boolean NOT NULL DEFAULT false,
  phase               text CHECK (phase IN ('pre_visit','post_visit','unknown')),
  note                text,
  created_by          uuid REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, property_inquiry_id, reason_id)
);

-- ============================================================================
-- 20. property_action_reviews
-- ============================================================================
CREATE TABLE public.property_action_reviews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES public.companies(id),
  property_id          uuid NOT NULL REFERENCES public.properties(id),
  alert_type           text CHECK (alert_type IN ('new_needs_photography','no_inquiry_5d','repeated_obstacle','photography_refresh_required','manual_review')),
  trigger_reason       text,
  severity             text CHECK (severity IN ('info','medium','high','urgent')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned')),
  rule_recommendation  jsonb,
  ai_recommendation    jsonb,
  decision             text,
  decision_note        text,
  created_by           uuid REFERENCES public.profiles(id),
  resolved_by          uuid REFERENCES public.profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz,
  resolved_at          timestamptz
);
CREATE INDEX property_action_reviews_company_id_idx ON public.property_action_reviews(company_id);

-- ============================================================================
-- 21. measurement_periods / 22. measurement_targets / 23. employee_monthly_targets
-- ============================================================================
CREATE TABLE public.measurement_periods (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id),
  name                     text NOT NULL,
  starts_on                date,
  ends_on                  date,
  definition_version       integer,
  status                   text NOT NULL DEFAULT 'active',
  participating_branches   text[],
  definitions_locked_at    timestamptz,
  owner_id                 uuid REFERENCES public.profiles(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz
);

CREATE TABLE public.measurement_targets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id),
  period_id    uuid NOT NULL REFERENCES public.measurement_periods(id),
  branch_key   text,
  metric_key   text,
  target_value numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_id, branch_key, metric_key)
);

CREATE TABLE public.employee_monthly_targets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id),
  employee_id              uuid NOT NULL REFERENCES public.profiles(id),
  month_start              date NOT NULL,
  inventory_target         integer,
  new_properties_target    integer,
  sold_target              numeric,
  commission_target        numeric,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz,
  UNIQUE (company_id, employee_id, month_start)
);

-- ============================================================================
-- 24. whatsapp_messages [VERIFY] -- out-of-scope but heavily FK'd
-- ============================================================================
CREATE TABLE public.whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id),
  conversation_id uuid,  -- FK added once whatsapp_conversations exists
  direction       text CHECK (direction IN ('inbound','outbound')),
  wa_message_id   text,
  from_number     text,
  to_number       text,
  body            text,
  media_url       text,
  message_type    text,
  status          text,
  raw_payload     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_messages_company_id_idx ON public.whatsapp_messages(company_id);

-- ============================================================================
-- 25. whatsapp_conversations
-- ============================================================================
CREATE TABLE public.whatsapp_conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id),
  client_id                uuid REFERENCES public.clients(id),
  assigned_to              uuid REFERENCES public.profiles(id),
  route_key                text,
  meta_phone_number_id     text,
  inbound_number           text,
  customer_wa_id           text,
  customer_phone           text,
  customer_name            text,
  status                   text,
  last_message_at          timestamptz,
  last_inbound_at          timestamptz,
  last_outbound_at         timestamptz,
  last_message_seq         bigint NOT NULL DEFAULT 0,
  read_through_seq         bigint NOT NULL DEFAULT 0,
  unread_count             integer NOT NULL DEFAULT 0,
  ai_summary               text,
  ai_last_extracted        jsonb,
  human_handoff_required   boolean NOT NULL DEFAULT false,
  handoff_reason           text,
  handoff_updated_at       timestamptz,
  last_automation_action   text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz
);
CREATE INDEX whatsapp_conversations_company_id_idx ON public.whatsapp_conversations(company_id);
ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES public.whatsapp_conversations(id);

-- Back-fill deferred FKs to whatsapp_messages now that it exists
ALTER TABLE public.client_requests ADD CONSTRAINT client_requests_origin_whatsapp_message_id_fkey
  FOREIGN KEY (origin_whatsapp_message_id) REFERENCES public.whatsapp_messages(id);
ALTER TABLE public.viewings ADD CONSTRAINT viewings_source_whatsapp_message_id_fkey
  FOREIGN KEY (source_whatsapp_message_id) REFERENCES public.whatsapp_messages(id);
ALTER TABLE public.property_inquiries ADD CONSTRAINT property_inquiries_source_whatsapp_message_id_fkey
  FOREIGN KEY (source_whatsapp_message_id) REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL;

-- ============================================================================
-- 26. unmatched_property_links
-- ============================================================================
CREATE TABLE public.unmatched_property_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id),
  client_id             uuid REFERENCES public.clients(id),
  conversation_id       uuid REFERENCES public.whatsapp_conversations(id),
  whatsapp_message_id   uuid REFERENCES public.whatsapp_messages(id),
  inbound_number        text,
  raw_url               text,
  link_key              text,
  provider              text CHECK (provider IN ('instagram','youtube','other')),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','ignored')),
  property_id           uuid REFERENCES public.properties(id),
  marketing_event_id    uuid REFERENCES public.property_marketing_events(id),
  occurrence_count      integer NOT NULL DEFAULT 1,
  resolved_by           uuid REFERENCES public.profiles(id),
  resolved_at           timestamptz,
  first_seen_at         timestamptz,
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz,
  UNIQUE (company_id, whatsapp_message_id, link_key)
);

-- ============================================================================
-- Remaining out-of-scope supporting tables [VERIFY] -- named/FK'd by triggers
-- and edge functions but not exhaustively column-checked. Minimal viable
-- definitions so triggers/functions in db/changes/*.sql have somewhere to
-- write; extend as gaps surface during testing.
-- ============================================================================
CREATE TABLE public.appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id),
  client_id    uuid REFERENCES public.clients(id),
  agent_id     uuid REFERENCES public.profiles(id),
  status       text,
  scheduled_at timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.viewings ADD CONSTRAINT viewings_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

-- activities (audit/timeline log; referenced by crm_save_viewing_atomic() in
-- 03-atomic-visits.forward.sql and by logActivity()/logAudit() in the frontend)
CREATE TABLE public.activities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id),
  user_id        uuid REFERENCES public.profiles(id),
  client_id      uuid REFERENCES public.clients(id),
  deal_id        uuid REFERENCES public.deals(id),
  property_id    uuid REFERENCES public.properties(id),
  request_id     uuid REFERENCES public.client_requests(id),
  appointment_id uuid REFERENCES public.appointments(id),
  type           text,
  description    text,
  activity_type  text,
  activity_text  text,
  channel        text,
  direction      text,
  actor_type     text,
  occurred_at    timestamptz,
  recorded_at    timestamptz,
  after_data     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_company_id_idx ON public.activities(company_id);
CREATE INDEX activities_client_id_idx ON public.activities(client_id) WHERE client_id IS NOT NULL;
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY activities_select_company ON public.activities FOR SELECT TO authenticated
USING (company_id = (SELECT public.my_company()));
CREATE POLICY activities_insert_staff ON public.activities FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.my_company()));

CREATE TABLE public.appointment_properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  property_id    uuid NOT NULL REFERENCES public.properties(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_message_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id),
  message_id  uuid REFERENCES public.whatsapp_messages(id),
  request_id  uuid REFERENCES public.client_requests(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_followup_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id),
  client_id   uuid REFERENCES public.clients(id),
  event_type  text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_followup_optins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id),
  client_id   uuid REFERENCES public.clients(id),
  opted_in_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_followup_optouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id),
  client_id    uuid REFERENCES public.clients(id),
  opted_out_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_template_registry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id),
  template_name text NOT NULL,
  language      text,
  status        text,
  body          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.deal_stage_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  deal_id    uuid NOT NULL REFERENCES public.deals(id),
  from_stage text,
  to_stage   text,
  changed_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_automation_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id),
  conversation_id uuid REFERENCES public.whatsapp_conversations(id),
  action      text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.client_request_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  request_id uuid NOT NULL REFERENCES public.client_requests(id),
  event_type text,
  payload    jsonb,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id    uuid REFERENCES public.profiles(id),
  title      text,
  body       text,
  type       text,
  read       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.instagram_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES public.companies(id),
  ig_user_id          text,
  username            text,
  access_token_secret text,  -- pointer to Vault secret name, never store raw token
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.instagram_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id),
  client_id         uuid REFERENCES public.clients(id),
  ig_account_id     uuid REFERENCES public.instagram_accounts(id),
  participant_id    text,
  status            text,
  last_message_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.instagram_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id),
  conversation_id uuid REFERENCES public.instagram_conversations(id),
  direction       text CHECK (direction IN ('inbound','outbound')),
  body            text,
  media_url       text,
  raw_payload     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.property_message_attributions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id),
  property_id           uuid NOT NULL REFERENCES public.properties(id),
  whatsapp_message_id   uuid REFERENCES public.whatsapp_messages(id),
  instagram_message_id  uuid REFERENCES public.instagram_messages(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.whatsapp_send_operations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id),
  operation_key  uuid NOT NULL,
  conversation_id uuid REFERENCES public.whatsapp_conversations(id),
  status         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.instagram_outbound_operations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id),
  operation_key  uuid NOT NULL,
  conversation_id uuid REFERENCES public.instagram_conversations(id),
  status         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- ============================================================================
-- Seed the global rejection_reasons catalog (codes observed in triggers)
-- ============================================================================
INSERT INTO public.rejection_reasons (company_id, code, label_ar, category, sort_order) VALUES
  (NULL, 'price_value_mismatch',    'السعر لا يناسب القيمة', 'price',    10),
  (NULL, 'location',                'الموقع غير مناسب',      'location', 20),
  (NULL, 'built_size',              'المساحة المبنية',       'size',     30),
  (NULL, 'layout',                  'التصميم الداخلي',       'design',   40),
  (NULL, 'finishing',               'التشطيب',                'design',   50),
  (NULL, 'yard_parking',            'الحديقة/المواقف',        'design',   60),
  (NULL, 'finance_not_ready',       'التمويل غير جاهز',       'finance',  70),
  (NULL, 'chose_other_property',    'اختار عقاراً آخر',       'other',    80),
  (NULL, 'no_response_after_visit', 'لا رد بعد المعاينة',      'engagement', 90),
  (NULL, 'client_not_ready',        'العميل غير جاهز',        'engagement', 100),
  (NULL, 'no_clear_reason',         'لا يوجد سبب واضح',       'other',    110)
ON CONFLICT DO NOTHING;
