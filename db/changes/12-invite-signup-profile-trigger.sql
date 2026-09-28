-- ============================================================================
-- Fix: employees who accept a team invite (إدارة الفريق) and confirm their
-- email get an auth.users row but never get a matching `profiles` row, so
-- login "loads but never enters" — loadAppInternal() in app-base-v15.html
-- selects profiles WHERE id = auth user id, gets nothing, throws "لم يكتمل
-- ملف هذا الحساب", and signs the user back out to the login screen.
--
-- Root cause: nothing in the schema ever consumed the `invite_token` that
-- handleSignup() stashes in auth user_metadata at signup time. This adds
-- the missing AFTER INSERT trigger on auth.users that creates the profile
-- from the matching pending company_invites row and marks the invite used.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.crm_handle_new_user_from_invite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $function$
DECLARE
  v_token   text;
  v_invite  public.company_invites%ROWTYPE;
BEGIN
  v_token := NEW.raw_user_meta_data->>'invite_token';
  IF v_token IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_invite FROM public.company_invites
    WHERE token = v_token AND status = 'pending' AND expires_at > now()
    LIMIT 1;

  IF v_invite.id IS NULL OR lower(v_invite.email) <> lower(NEW.email) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.profiles (id, company_id, full_name, email, phone, role, is_active)
  VALUES (
    NEW.id,
    v_invite.company_id,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), split_part(NEW.email, '@', 1)),
    NEW.email,
    NULLIF(NEW.raw_user_meta_data->>'phone', ''),
    v_invite.role,
    true
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.company_invites
    SET status = 'used', used_by = NEW.id, used_at = now()
    WHERE id = v_invite.id;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS crm_on_auth_user_created_from_invite ON auth.users;
CREATE TRIGGER crm_on_auth_user_created_from_invite
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.crm_handle_new_user_from_invite();

-- Trigger-only: never callable directly via the public REST API.
REVOKE EXECUTE ON FUNCTION public.crm_handle_new_user_from_invite() FROM PUBLIC, anon, authenticated;

COMMIT;
