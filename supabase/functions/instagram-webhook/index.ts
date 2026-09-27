import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRM_COMPANY_ID = Deno.env.get("CRM_COMPANY_ID") ?? "";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const META_GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
const INSTAGRAM_VERIFY_TOKEN = Deno.env.get("INSTAGRAM_VERIFY_TOKEN") || "maskaan0-crm-instagram-webhook-2026";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const encoder = new TextEncoder();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function hexToBytes(hex: string) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function verifySignature(raw: string, header: string | null) {
  if (!META_APP_SECRET || !header?.startsWith("sha256=")) return false;
  const supplied = hexToBytes(header.slice(7));
  if (!supplied) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)));
  return constantTimeEqual(actual, supplied);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function decryptToken(ciphertext: string, ivB64: string, companyId: string, accountId: string) {
  const seed = encoder.encode(`${META_APP_SECRET}|${companyId}|${accountId}|maskaan0-crm-instagram-v1`);
  const digest = await crypto.subtle.digest("SHA-256", seed);
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, key, b64ToBytes(ciphertext));
  return new TextDecoder().decode(plain);
}

async function graph(path: string, token: string) {
  const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path.replace(/^\//, "")}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Meta HTTP ${response.status}`);
  return payload;
}

function eventBody(event: any) {
  if (event?.message?.text) return String(event.message.text).slice(0, 6000);
  const attachment = event?.message?.attachments?.[0];
  if (attachment?.payload?.url) return String(attachment.payload.url).slice(0, 6000);
  if (event?.postback?.title || event?.postback?.payload) return String(event.postback.title || event.postback.payload).slice(0, 6000);
  if (event?.reaction?.reaction) return `تفاعل: ${event.reaction.reaction}`;
  return "";
}

function eventType(event: any) {
  if (event?.message?.attachments?.length) return String(event.message.attachments[0]?.type || "attachment");
  if (event?.message) return "text";
  if (event?.postback) return "postback";
  if (event?.reaction) return "reaction";
  if (event?.read) return "read";
  return "unknown";
}

function messagingEvents(entry: any) {
  const events = Array.isArray(entry?.messaging) ? [...entry.messaging] : [];
  for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    if (Array.isArray(change?.value?.messaging)) events.push(...change.value.messaging);
    else if (change?.field === "messages" && change?.value && typeof change.value === "object") events.push(change.value);
  }
  return events;
}

async function accountForEntry(entryId: string, event: any) {
  const ids = [entryId, String(event?.recipient?.id || ""), String(event?.sender?.id || "")].filter(Boolean);
  const { data, error } = await admin.from("instagram_accounts").select("*").eq("company_id", CRM_COMPANY_ID).or(ids.map((id) => `instagram_user_id.eq.${id},facebook_page_id.eq.${id}`).join(",")).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === INSTAGRAM_VERIFY_TOKEN && challenge) return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CRM_COMPANY_ID || !META_APP_SECRET) return json({ ok: false, error: "server_not_configured" }, 503);

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256")))) return json({ ok: false, error: "invalid_signature" }, 401);
  let payload: any;
  try { payload = JSON.parse(raw || "{}"); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const eventKey = await sha256(raw);
  const inserted = await admin.from("instagram_webhook_events").insert({ company_id: CRM_COMPANY_ID, event_key: eventKey, object_type: payload?.object || null, payload, processing_status: "processing" });
  if (inserted.error?.code === "23505") {
    const previous = await admin.from("instagram_webhook_events").select("processing_status").eq("event_key", eventKey).single();
    if (previous.error) return json({ ok: false, error: "event_reload_failed" }, 500);
    if (previous.data?.processing_status === "processed") return json({ ok: true, duplicate: true });
    // Failed delivery remains retryable. Message uniqueness makes replay safe.
  }
  if (inserted.error && inserted.error.code !== "23505") return json({ ok: false, error: "event_save_failed" }, 500);

  try {
    let processed = 0;
    for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
      for (const event of messagingEvents(entry)) {
        if (!event?.message && !event?.postback) continue; // reactions/read receipts are not new leads/messages
        const account = await accountForEntry(String(entry?.id || ""), event);
        if (!account) continue;
        const senderId = String(event?.sender?.id || "");
        const recipientId = String(event?.recipient?.id || "");
        const isEcho = event?.message?.is_echo === true || senderId === String(account.instagram_user_id);
        const participantId = isEcho ? recipientId : senderId;
        if (!participantId) continue;

        const { data: credential } = await admin.from("instagram_account_credentials").select("token_ciphertext,token_iv").eq("account_id", account.id).maybeSingle();
        let participantUsername: string | null = null;
        let participantName: string | null = null;
        let participantPicture: string | null = null;
        if (credential) {
          try {
            const accessToken = await decryptToken(credential.token_ciphertext, credential.token_iv, CRM_COMPANY_ID, account.id);
            const profile = await graph(`${participantId}?fields=id,username,name,profile_pic`, accessToken);
            participantUsername = profile?.username || null;
            participantName = profile?.name || null;
            participantPicture = profile?.profile_pic || null;
          } catch { /* Profile lookup is optional. */ }
        }

        let clientId: string | null = null;
        const existingClient = await admin.from("clients").select("id,name").eq("company_id", CRM_COMPANY_ID).eq("instagram_participant_id", participantId).maybeSingle();
        if (existingClient.data?.id) clientId = existingClient.data.id;
        else if (!isEcho) {
          const displayName = participantName || (participantUsername ? `@${participantUsername}` : `Instagram ${participantId.slice(-6)}`);
          const created = await admin.from("clients").insert({ company_id: CRM_COMPANY_ID, name: displayName, source: "instagram", instagram_participant_id: participantId, status: "warm", pipeline_stage: "new", is_buyer: false, is_seller: false, is_investor: false, notes: `عميل من Instagram${participantUsername ? ` @${participantUsername}` : ""}`, last_contact_at: new Date().toISOString() }).select("id").single();
          if (created.error?.code === "23505") {
            const retryClient = await admin.from("clients").select("id").eq("company_id", CRM_COMPANY_ID).eq("instagram_participant_id", participantId).single();
            if (retryClient.error) throw new Error("instagram_client_reload_failed");
            clientId = retryClient.data.id;
          } else {
            if (created.error) throw new Error("instagram_client_save_failed");
            clientId = created.data?.id || null;
          }
        }

        const timestamp = event?.timestamp ? new Date(Number(event.timestamp)).toISOString() : new Date().toISOString();
        const conversationPayload = { company_id: CRM_COMPANY_ID, account_id: account.id, client_id: clientId || undefined, participant_id: participantId, participant_username: participantUsername, participant_name: participantName, participant_profile_picture_url: participantPicture, updated_at: new Date().toISOString() };
        const conversationResult = await admin.from("instagram_conversations").upsert(conversationPayload, { onConflict: "account_id,participant_id" }).select("id,unread_count").single();
        if (conversationResult.error || !conversationResult.data) throw conversationResult.error || new Error("conversation_save_failed");
        const conversation = conversationResult.data;

        const messageId = String(event?.message?.mid || event?.postback?.mid || event?.reaction?.mid || `event-${eventKey}-${processed}`);
        const body = eventBody(event);
        const storedMessage = await admin.from("instagram_messages").upsert({ company_id: CRM_COMPANY_ID, conversation_id: conversation.id, client_id: clientId, instagram_message_id: messageId, direction: isEcho ? "outbound" : "inbound", message_type: eventType(event), sender_id: senderId || null, recipient_id: recipientId || null, body: body || null, media_url: event?.message?.attachments?.[0]?.payload?.url || null, reply_to_message_id: event?.message?.reply_to?.mid || null, message_timestamp: timestamp, delivery_status: isEcho ? "sent" : "received", raw_payload: event }, { onConflict: "company_id,instagram_message_id", ignoreDuplicates: true });
        if (storedMessage.error) throw new Error("instagram_message_save_failed");

        processed++;
      }
    }
    await admin.from("instagram_webhook_events").update({ processing_status: "processed", processed_at: new Date().toISOString() }).eq("event_key", eventKey);
    return json({ ok: true, processed });
  } catch (error) {
    const message = String((error as any)?.message || error).slice(0, 1500);
    console.error("[instagram-webhook]", message);
    await admin.from("instagram_webhook_events").update({ processing_status: "failed", processing_error: message, processed_at: new Date().toISOString() }).eq("event_key", eventKey);
    return json({ ok: false, error: "processing_failed", message }, 500);
  }
});

