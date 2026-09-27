# Operations review — 2026-09-27

Baseline: `5b3c779e0aceb5dc4a233d3ddeeedfe56b82b432`. Backup branch: `backup/pre-operations-review-20260927`.

## Applied
- Dashboard staff target reminder; owner monthly targets (active inventory default 10, newly sourced listings, sales, company commission).
- New `employee_monthly_targets` with owner write / employee own read RLS; `properties.sourced_by` and guard; no historical property is automatically attributed.
- Client 360 returns the latest 12 WhatsApp messages per direction and links to the full conversation.
- WhatsApp inbox excludes active staff phone numbers, including the owner's self conversation, and subtracts their unread counts. Manual CRM read marking is disabled in the Edge Function and EXECUTE privilege revoked for authenticated users. Phone app read events are not currently available as a reliable inbound signal.
- Reports navigation and route restricted to owner; redundant advanced search removed; visits ordered by overdue/today/upcoming/history and compacted; legacy lost deal notes distinguished from truly blank reasons.
- TEST_CRM_REPAIR_PROPERTY_20260923 archived, no deletion.
- Duplicate Khoudh Al Kawthar 140 archived (`cde048c6-9b2b-4643-aa80-48a3dc19c902`); its reel event `645905a8-adab-4c0a-afd9-c38595d9b253` moved to canonical `473b069f-e984-4cd9-a883-6c854009dc7c`. Three reels remain linked; historic activity and action reviews remain attached to archived record.

## Verification
- Browser anonymous load showed version `20260927-operations-v2`, removed search page and team target panel in DOM; no application error in console. Authenticated UI unavailable in this browser.
- SQL RLS rollback tests: owner can insert target; intended employee can select own target; colleague sees zero; employee attempting to change sourced_by gets `property_source_owner_only`.
- Client 360 sample returned 24 messages, including 12 outbound. Authenticated role cannot execute `crm_mark_whatsapp_read`.
- The 120 Khoudh Seventh property has three reels and zero matched WhatsApp messages / inbound inquiries: the no-inquiry alert reflects current attribution data.

## Reversal
- Static UI: reset `main` to backup branch commit via normal forward revert of the operations commit.
- WhatsApp inbox: redeploy version 9 from the repository backup branch; restore function EXECUTE to authenticated only if manual CRM marking is explicitly desired.
- Test property restore: `update public.properties set archived=false,archived_at=null,archived_by=null where id='dd95be18-651e-42fe-a105-837cafdac6fb';`
- Duplicate restore: within a transaction, move event `645905a8-adab-4c0a-afd9-c38595d9b253` back to `cde048c6-9b2b-4643-aa80-48a3dc19c902`, then clear its archived fields. Do not delete either property or the event.
- Target schema is additive. Preserve any entered targets / sourced_by values in a database export before considering a schema rollback.

## Pending provider and policy decisions
- WhatsApp Business phone-side read state cannot be inferred from opening CRM or from outbound echoes; leave unread indicators unchanged until an official reliable read event is available.
- Bonus formula and monthly commission target amounts are not configured. Owner can set numeric goals; no bonus is calculated.
- Historic properties need explicit owner review to assign sourced_by; attribution is not guessed from added_by.
