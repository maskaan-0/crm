-- ============================================================================
-- Consolidated schema-gap fixes discovered while applying 03 through
-- edge-support-forward.sql against the reconstructed bootstrap schema.
-- Run this AFTER 08-storage.forward.sql and BEFORE financial-01-financial-views.forward.sql.
--
-- Root cause: db/changes/*.forward.sql are patches written against an original
-- schema/policy set kept in a private backup that is not in this repo (see
-- db/changes/README.md). The reconstructed 00-bootstrap-schema.sql could not
-- perfectly anticipate every column/table those patches assume already
-- exists. This file adds what was missing, discovered by actually running
-- each patch file against a live database and fixing each error in turn.
-- ============================================================================

BEGIN;

-- ---- for financial-01-financial-views.forward.sql ----
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS deposit_amount numeric,
  ADD COLUMN IF NOT EXISTS closing_probability numeric,
  ADD COLUMN IF NOT EXISTS expected_close_date date,
  ADD COLUMN IF NOT EXISTS bank_financing text,
  ADD COLUMN IF NOT EXISTS company_commission numeric,
  ADD COLUMN IF NOT EXISTS agent_commission numeric,
  ADD COLUMN IF NOT EXISTS company_share numeric,
  ADD COLUMN IF NOT EXISTS agent_share numeric,
  ADD COLUMN IF NOT EXISTS commission_status text,
  ADD COLUMN IF NOT EXISTS broker_id uuid REFERENCES public.owners(id),
  ADD COLUMN IF NOT EXISTS broker_commission numeric;

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS appointment_at timestamptz,
  ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES public.client_requests(id),
  ADD COLUMN IF NOT EXISTS branch_key text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attended_at timestamptz,
  ADD COLUMN IF NOT EXISTS visit_notes text,
  ADD COLUMN IF NOT EXISTS result text,
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS next_followup date;

ALTER TABLE public.appointment_properties ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.appointment_properties ADD COLUMN IF NOT EXISTS interest_level text;
UPDATE public.appointment_properties ap SET company_id = a.company_id
  FROM public.appointments a WHERE a.id = ap.appointment_id AND ap.company_id IS NULL;
ALTER TABLE public.appointment_properties ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.appointment_properties
  ADD CONSTRAINT appointment_properties_unique UNIQUE (company_id, appointment_id, property_id);

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS sent_by_user_id uuid REFERENCES public.profiles(id);

-- BEST-EFFORT reconstruction: extracts a stable dedupe key from an Instagram
-- or YouTube URL. Referenced by crm_property_action_queue() but never
-- defined anywhere in this repo. funnel-forward.sql later replaces this with
-- a more precise regex-based version -- both are kept compatible in shape.
CREATE OR REPLACE FUNCTION public.normalize_property_marketing_link(p_url text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_url IS NULL OR btrim(p_url) = '' THEN NULL
    WHEN p_url ~* 'instagram\.com/(reel|p)/[A-Za-z0-9_-]+'
      THEN 'instagram:' || substring(p_url from 'instagram\.com/(?:reel|p)/([A-Za-z0-9_-]+)')
    WHEN p_url ~* 'youtu\.be/[A-Za-z0-9_-]+'
      THEN 'youtube:' || substring(p_url from 'youtu\.be/([A-Za-z0-9_-]+)')
    WHEN p_url ~* 'youtube\.com/watch\?v=[A-Za-z0-9_-]+'
      THEN 'youtube:' || substring(p_url from 'v=([A-Za-z0-9_-]+)')
    ELSE 'other:' || p_url
  END;
$$;

-- ---- for 07-manual-assignment.forward.sql (fixed in-place; see that file) ----
-- crm_infer_request_branches() and the corrected crm_refresh_client_primary_assignment()
-- signature now live directly in 07-manual-assignment.forward.sql and
-- 00b-bootstrap-rls.sql respectively.

-- ---- for conversation-sequence-backfill.sql / instagram-conversation-forward.sql ----
ALTER TABLE public.instagram_messages ADD COLUMN IF NOT EXISTS ingestion_seq bigint;
ALTER TABLE public.instagram_messages ADD COLUMN IF NOT EXISTS message_timestamp timestamptz;
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS last_message_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS read_through_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS unread_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.profiles(id);
ALTER TABLE public.instagram_conversations ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ---- for instagram-send-forward.sql ----
-- 00-bootstrap-schema.sql created instagram_outbound_operations with an
-- incompatible column set (a guess made before this file's real shape was
-- known). instagram-send-forward.sql uses `CREATE TABLE IF NOT EXISTS`, which
-- would silently keep the wrong structure if the table already exists.
DROP TABLE IF EXISTS public.instagram_outbound_operations;

-- ---- for funnel-forward.sql ----
-- Same problem: 00-bootstrap-schema.sql's property_message_attributions guess
-- doesn't match this file's real (and much larger) schema.
DROP TABLE IF EXISTS public.property_message_attributions;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS matched_property_id uuid REFERENCES public.properties(id),
  ADD COLUMN IF NOT EXISTS matched_marketing_event_id uuid REFERENCES public.property_marketing_events(id),
  ADD COLUMN IF NOT EXISTS property_match_status text,
  ADD COLUMN IF NOT EXISTS property_link_key text,
  ADD COLUMN IF NOT EXISTS recipient_wa_id text;

ALTER TABLE public.whatsapp_message_requests ADD COLUMN IF NOT EXISTS relation text;
ALTER TABLE public.whatsapp_message_requests
  ADD CONSTRAINT whatsapp_message_requests_message_request_uidx UNIQUE (message_id, request_id);

-- Missing trigger function that funnel-forward.sql's trigger assumes already
-- exists. funnel-forward.sql (re)creates normalize_property_marketing_link()
-- and property_link_provider() with more precise logic than the stub above;
-- since this is plpgsql, the body isn't validated until the trigger actually
-- fires, so creating it here (referencing functions defined later in the
-- sequence) is safe.
CREATE OR REPLACE FUNCTION public.set_property_marketing_link_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  new.link_key := public.normalize_property_marketing_link(new.url);
  new.link_provider := public.property_link_provider(new.url);
  RETURN new;
END;
$$;

-- ---- for edge-support-forward.sql ----
-- Same incompatible-guess problem as the two tables above (this one has no
-- IF NOT EXISTS guard at all, so it must be dropped first or the file errors
-- outright rather than silently keeping the wrong shape).
DROP TABLE IF EXISTS public.whatsapp_send_operations;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS actor_type text,
  ADD COLUMN IF NOT EXISTS transcript text,
  ADD COLUMN IF NOT EXISTS automation_result jsonb;

COMMIT;
