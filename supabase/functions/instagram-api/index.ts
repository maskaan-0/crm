import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRM_COMPANY_ID = Deno.env.get("CRM_COMPANY_ID") ?? "";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const META_GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
const META_APP_ID = "1639659247753419";
const TARGET_IG_ID = "17841444560608289";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
}

function bytesToB64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function credentialKey(companyId: string, accountId: string) {
  const seed = new TextEncoder().encode(`${META_APP_SECRET}|${companyId}|${accountId}|maskaan0-crm-instagram-v1`);
  const digest = await crypto.subtle.digest("SHA-256", seed);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, companyId: string, accountId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await credentialKey(companyId, accountId);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { token_ciphertext: bytesToB64(new Uint8Array(cipher)), token_iv: bytesToB64(iv) };
}

async function decryptToken(ciphertext: string, ivB64: string, companyId: string, accountId: string) {
  const key = await credentialKey(companyId, accountId);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, key, b64ToBytes(ciphertext));
  return new TextDecoder().decode(plain);
}

async function graph(path: string, token: string, init: RequestInit = {}, host = "graph.facebook.com") {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.method && init.method !== "GET" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const url = path.startsWith("http") ? path : `https://${host}/${META_GRAPH_VERSION}/${path.replace(/^\//, "")}`;
  const target = new URL(url);
  if (target.protocol !== "https:" || !["graph.facebook.com", "graph.instagram.com"].includes(target.hostname)) throw new Error("invalid_meta_paging_host");
  const response = await fetch(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(20000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.error_user_msg || payload?.error?.message || `Meta HTTP ${response.status}`);
  return payload;
}

function shortcodeFromUrl(value: string) {
  try {
    const url = new URL(/^https?:\/\//i.test(String(value)) ? String(value) : `https://${value}`);
    if (!["instagram.com", "www.instagram.com", "instagr.am", "www.instagr.am"].includes(url.hostname.toLowerCase())) return "";
    return url.pathname.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/)?.[1] || "";
  } catch { return ""; }
}

async function loadMediaIndex(instagramUserId: string, token: string, shortcodes: Set<string>) {
  const mediaByShortcode = new Map<string, any>();
  let nextUrl = `${instagramUserId}/media?fields=id,permalink,shortcode,media_type,timestamp,like_count,comments_count&limit=100`;
  let page = 0;
  while (nextUrl && page < 10 && mediaByShortcode.size < shortcodes.size) {
    const payload = await graph(nextUrl, token);
    for (const media of Array.isArray(payload?.data) ? payload.data : []) {
      const shortcode = String(media?.shortcode || shortcodeFromUrl(media?.permalink || ""));
      if (shortcode && shortcodes.has(shortcode)) mediaByShortcode.set(shortcode, media);
    }
    nextUrl = String(payload?.paging?.next || "");
    page += 1;
  }
  return mediaByShortcode;
}

async function loadMediaMetrics(media: any, token: string) {
  const metrics: Record<string, number> = {};
  const names = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "plays", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time", "replays"];
  for (const metric of names) {
    try {
      const result = await graph(`${media.id}/insights?metric=${metric}`, token);
      const value = Number(result?.data?.[0]?.total_value?.value ?? result?.data?.[0]?.values?.[0]?.value ?? result?.data?.[0]?.value);
      if (Number.isFinite(value)) metrics[metric] = value;
    } catch { /* Metric availability varies by media type and publication date. */ }
  }
  if (Number.isFinite(Number(media.like_count))) metrics.likes = Number(media.like_count);
  if (Number.isFinite(Number(media.comments_count))) metrics.comments = Number(media.comments_count);
  if (!Number.isFinite(metrics.total_interactions) && ["likes", "comments", "shares", "saved"].every((key) => Number.isFinite(metrics[key]))) {
    metrics.total_interactions = (metrics.likes || 0) + (metrics.comments || 0) + (metrics.shares || 0) + (metrics.saved || 0);
  }
  return metrics;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !META_APP_SECRET) return json({ ok: false, error: "server_not_configured" }, 503);

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "missing_auth" }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const { data: userData, error: userError } = await userClient.auth.getUser();
    const user = userData?.user;
    if (userError || !user) return json({ ok: false, error: "invalid_auth" }, 401);
    const { data: profile, error: profileError } = await admin.from("profiles").select("id,company_id,role,is_active").eq("id", user.id).single();
    if (profileError || !profile || profile.is_active !== true) return json({ ok: false, error: "profile_not_authorized" }, 403);
    if (CRM_COMPANY_ID && profile.company_id !== CRM_COMPANY_ID) return json({ ok: false, error: "wrong_company" }, 403);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "status");

    if (action === "connect") {
      if (!["owner", "manager"].includes(profile.role)) return json({ ok: false, error: "owner_or_manager_required" }, 403);
      const shortToken = String(body?.access_token || "").trim();
      if (!shortToken) return json({ ok: false, error: "access_token_required" }, 400);

      const appToken = `${META_APP_ID}|${META_APP_SECRET}`;
      const debug = await graph(`debug_token?input_token=${encodeURIComponent(shortToken)}`, appToken);
      if (!debug?.data?.is_valid || String(debug?.data?.app_id) !== META_APP_ID) throw new Error("The Meta login token is invalid or belongs to another app");
      const grantedScopes = Array.isArray(debug?.data?.scopes) ? debug.data.scopes.map(String) : [];

      const exchangeUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${encodeURIComponent(META_APP_SECRET)}&grant_type=fb_exchange_token&fb_exchange_token=${encodeURIComponent(shortToken)}`;
      const exchangeResponse = await fetch(exchangeUrl);
      const exchange = await exchangeResponse.json().catch(() => ({}));
      if (!exchangeResponse.ok || !exchange?.access_token) throw new Error(exchange?.error?.message || "long_lived_token_exchange_failed");
      const longToken = String(exchange.access_token);

      const fields = "id,name,access_token,tasks,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count}";
      const pages = await graph(`me/accounts?fields=${encodeURIComponent(fields)}&limit=100`, longToken);
      const expectedIgId = String(body?.instagram_user_id || TARGET_IG_ID);
      const page = (Array.isArray(pages?.data) ? pages.data : []).find((candidate: any) => {
        const ig = candidate?.instagram_business_account;
        return ig && (String(ig.id) === expectedIgId || String(ig.username || "").toLowerCase() === "omanvilla");
      });
      if (!page?.instagram_business_account?.id || !page?.access_token) throw new Error("Omanvilla Instagram account was not found among the Facebook Pages available to this login");
      const ig = page.instagram_business_account;
      const pageToken = String(page.access_token);

      let webhookSubscribed = false;
      let subscriptionError = "";
      for (const targetId of [String(ig.id), String(page.id)]) {
        for (const fieldsValue of ["messages,messaging_postbacks,message_reactions,messaging_seen", "messages"]) {
          try {
            const params = new URLSearchParams({ subscribed_fields: fieldsValue });
            const subscribed = await graph(`${targetId}/subscribed_apps?${params}`, pageToken, { method: "POST", body: "{}" });
            if (subscribed?.success === true) { webhookSubscribed = true; break; }
          } catch (error) { subscriptionError = String((error as any)?.message || error).slice(0, 700); }
        }
        if (webhookSubscribed) break;
      }

      const now = new Date().toISOString();
      const expirySeconds = Number(exchange?.expires_in || 0);
      const tokenExpiresAt = expirySeconds > 0 ? new Date(Date.now() + expirySeconds * 1000).toISOString() : null;
      const accountPayload = {
        company_id: profile.company_id,
        facebook_page_id: String(page.id),
        facebook_page_name: page.name || null,
        instagram_user_id: String(ig.id),
        instagram_username: ig.username || null,
        instagram_name: ig.name || null,
        profile_picture_url: ig.profile_picture_url || null,
        followers_count: Number.isFinite(Number(ig.followers_count)) ? Number(ig.followers_count) : null,
        media_count: Number.isFinite(Number(ig.media_count)) ? Number(ig.media_count) : null,
        permissions: grantedScopes,
        webhook_subscribed: webhookSubscribed,
        connection_status: "connected",
        connected_by: user.id,
        connected_at: now,
        token_expires_at: tokenExpiresAt,
        last_checked_at: now,
        last_error: subscriptionError || null,
        metadata: { page_tasks: page.tasks || [], token_source: "facebook_login", graph_version: META_GRAPH_VERSION },
        updated_at: now,
      };
      const { data: account, error: accountError } = await admin.from("instagram_accounts").upsert(accountPayload, { onConflict: "company_id,instagram_user_id" }).select("id").single();
      if (accountError || !account) throw new Error(accountError?.message || "instagram_account_save_failed");
      const encrypted = await encryptToken(pageToken, profile.company_id, account.id);
      const { error: credentialError } = await admin.from("instagram_account_credentials").upsert({ account_id: account.id, company_id: profile.company_id, ...encrypted, token_type: "facebook_page_long_lived", updated_at: now }, { onConflict: "account_id" });
      if (credentialError) throw new Error(credentialError.message);
      await admin.from("activities").insert({ company_id: profile.company_id, user_id: user.id, activity_type: "system", activity_text: `تم ربط Instagram @${ig.username || ig.id} بالـCRM`, actor_type: "human", channel: "instagram", direction: "internal", occurred_at: now });
      return json({ ok: true, instagram_user_id: String(ig.id), username: ig.username || null, page_id: String(page.id), webhook_subscribed: webhookSubscribed, permissions: grantedScopes, token_expires_at: tokenExpiresAt, warning: subscriptionError || null });
    }

    const { data: account, error: accountError } = await admin.from("instagram_accounts").select("*").eq("company_id", profile.company_id).eq("connection_status", "connected").order("connected_at", { ascending: false }).limit(1).maybeSingle();
    if (action === "status") {
      if (accountError) throw accountError;
      if (!account) return json({ ok: true, connected: false });
      return json({ ok: true, connected: true, account: { id: account.id, instagram_user_id: account.instagram_user_id, username: account.instagram_username, name: account.instagram_name, profile_picture_url: account.profile_picture_url, followers_count: account.followers_count, media_count: account.media_count, webhook_subscribed: account.webhook_subscribed, permissions: account.permissions, token_expires_at: account.token_expires_at, last_checked_at: account.last_checked_at, last_error: account.last_error } });
    }
    if (!account) return json({ ok: false, error: "instagram_not_connected" }, 409);

    if (action === "list") {
      const { data, error } = await userClient.from("instagram_conversations").select("*").eq("company_id", profile.company_id).eq("account_id", account.id).order("last_message_at", { ascending: false }).limit(200);
      if (error) throw error;
      return json({ ok: true, conversations: data || [], unread_total: (data || []).reduce((sum: number, item: any) => sum + Number(item.unread_count || 0), 0) });
    }

    if (action === "conversation") {
      const conversationId = String(body?.conversation_id || "");
      const { data: conversation, error: conversationError } = await userClient.from("instagram_conversations").select("*").eq("id", conversationId).eq("company_id", profile.company_id).single();
      if (conversationError) throw conversationError;
      const { data: messages, error: messageError } = await userClient.from("instagram_messages").select("*").eq("conversation_id", conversationId).eq("company_id", profile.company_id).order("message_timestamp", { ascending: false }).order("id", { ascending: false }).limit(500);
      if (messageError) throw messageError;
      const throughMessage = (messages || []).reduce((best: any, item: any) => !best || Number(item.ingestion_seq || 0) > Number(best.ingestion_seq || 0) ? item : best, null);
      return json({ ok: true, conversation, messages: (messages || []).reverse(), has_more: (messages || []).length === 500, read_through_message_id: throughMessage?.id || null });
    }

    if (action === "mark_read") {
      const { data, error } = await userClient.rpc("crm_mark_instagram_read", { p_conversation_id: String(body?.conversation_id || ""), p_message_id: String(body?.through_message_id || "") });
      if (error) return json({ ok: false, error: "mark_read_not_allowed" }, 403);
      return json(data);
    }
    const { data: credential, error: credentialError } = await admin.from("instagram_account_credentials").select("token_ciphertext,token_iv").eq("account_id", account.id).single();
    if (credentialError || !credential) throw new Error("instagram_credential_missing");
    const accessToken = await decryptToken(credential.token_ciphertext, credential.token_iv, profile.company_id, account.id);

    if (action === "send") {
      if (!["owner", "manager", "agent"].includes(profile.role)) return json({ ok: false, error: "write_role_required" }, 403);
      const conversationId = String(body?.conversation_id || "");
      const operationId = String(body?.operation_id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) return json({ ok: false, error: "operation_id_required" }, 400);
      const message = String(body?.body || "").trim().slice(0, 1000);
      if (!conversationId || !message) return json({ ok: false, error: "conversation_and_message_required" }, 400);
      const { data: conversation, error: conversationError } = await userClient.from("instagram_conversations").select("*").eq("id", conversationId).eq("company_id", profile.company_id).eq("account_id", account.id).single();
      if (conversationError || !conversation) throw new Error("conversation_not_found");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message)));
      const bodyHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const claim = await admin.rpc("crm_claim_instagram_send", { p_company_id: profile.company_id, p_operation_id: operationId, p_conversation_id: conversationId, p_actor_id: user.id, p_body_sha256: bodyHash });
      if (claim.error) return json({ ok: false, error: "send_operation_unavailable", retry_safe: false }, 409);
      if (!claim.data?.claimed) {
        if (claim.data?.status === "sent") return json({ ok: claim.data.recorded === true, sent: true, recorded: claim.data.recorded === true, retry_safe: false, duplicate: true, message_id: claim.data.message_id, error: claim.data.recorded ? undefined : "message_sent_but_local_save_failed" });
        return json({ ok: false, error: "send_status_requires_review", sent: null, retry_safe: false, operation_id: operationId }, 409);
      }
      const requestBody = JSON.stringify({ recipient: { id: conversation.participant_id }, message: { text: message } });
      let sent: any;
      try { sent = await graph(`${account.instagram_user_id}/messages`, accessToken, { method: "POST", body: requestBody }); }
      catch {
        await admin.from("instagram_outbound_operations").update({ status: "uncertain", error_code: "meta_result_unconfirmed", updated_at: new Date().toISOString() }).eq("company_id", profile.company_id).eq("operation_id", operationId);
        return json({ ok: false, error: "send_status_requires_review", sent: null, retry_safe: false, operation_id: operationId }, 502);
      }
      const messageId = String(sent?.message_id || sent?.id || "");
      if (!messageId) {
        await admin.from("instagram_outbound_operations").update({ status: "uncertain", error_code: "meta_message_id_missing", updated_at: new Date().toISOString() }).eq("company_id", profile.company_id).eq("operation_id", operationId);
        return json({ ok: false, error: "send_status_requires_review", sent: null, retry_safe: false, operation_id: operationId }, 502);
      }
      const now = new Date().toISOString();
      const receipt = await admin.from("instagram_outbound_operations").update({ status: "sent", instagram_message_id: messageId, updated_at: now }).eq("company_id", profile.company_id).eq("operation_id", operationId);
      const persisted = await admin.from("instagram_messages").upsert({ company_id: profile.company_id, conversation_id: conversation.id, client_id: conversation.client_id, instagram_message_id: messageId, direction: "outbound", message_type: "text", sender_id: account.instagram_user_id, recipient_id: conversation.participant_id, body: message, message_timestamp: now, delivery_status: "sent", sent_by_user_id: user.id, raw_payload: sent }, { onConflict: "company_id,instagram_message_id" });
      if (persisted.error || receipt.error) return json({ ok: false, sent: true, recorded: false, retry_safe: false, message_id: messageId, operation_id: operationId, error: "message_sent_but_local_save_failed" });
      const completed = await admin.from("instagram_outbound_operations").update({ recorded: true, updated_at: new Date().toISOString() }).eq("company_id", profile.company_id).eq("operation_id", operationId);
      if (completed.error) return json({ ok: false, sent: true, recorded: false, retry_safe: false, message_id: messageId, operation_id: operationId, error: "message_sent_but_receipt_update_failed" });
      // Timestamps are maintained by the atomic Instagram message trigger.
      return json({ ok: true, sent: true, recorded: true, retry_safe: false, message_id: messageId });
    }

    if (action === "sync_property") {
      if (!["owner", "manager", "agent"].includes(profile.role)) return json({ ok: false, error: "write_role_required" }, 403);
      const eventId = String(body?.event_id || "");
      const propertyId = String(body?.property_id || "");
      let eventQuery = userClient.from("property_marketing_events").select("id,url,property_id,channel,published_at").eq("company_id", profile.company_id).eq("channel", "instagram").not("url", "is", null);
      if (propertyId) eventQuery = eventQuery.eq("property_id", propertyId);
      else if (eventId) eventQuery = eventQuery.eq("id", eventId);
      else return json({ ok: false, error: "property_id_or_event_id_required" }, 400);
      const { data: events, error: eventError } = await eventQuery.order("published_at", { ascending: false });
      if (eventError) throw eventError;
      if (!events?.length) throw new Error("instagram_marketing_event_not_found");

      const eventShortcodes = new Map<string, string>();
      for (const event of events) {
        const shortcode = shortcodeFromUrl(event.url || "");
        if (shortcode) eventShortcodes.set(event.id, shortcode);
      }
      if (!eventShortcodes.size) throw new Error("instagram_permalink_required");
      const mediaIndex = await loadMediaIndex(account.instagram_user_id, accessToken, new Set(eventShortcodes.values()));
      const results: any[] = [];
      const countedMedia = new Set<string>();
      const metricCache = new Map<string, Record<string, number>>();
      const totals = { views: 0, plays: 0, reach_non_unique: 0, likes: 0, comments: 0, shares: 0, saves: 0, total_interactions: 0, watch_time_ms: 0, replays: 0 };

      for (const event of events) {
        const shortcode = eventShortcodes.get(event.id) || "";
        const media = mediaIndex.get(shortcode);
        if (!media?.id) {
          const message = "instagram_media_not_found_or_not_owned_by_omanvilla";
          await admin.from("property_marketing_events").update({ link_key: shortcode ? `instagram:${shortcode}` : null, link_provider: "instagram", auto_sync: true, sync_status: "error", last_synced_at: new Date().toISOString(), sync_error: message }).eq("id", event.id).eq("company_id", profile.company_id);
          results.push({ event_id: event.id, shortcode, ok: false, error: message });
          continue;
        }
        try {
          const metrics = metricCache.get(String(media.id)) || await loadMediaMetrics(media, accessToken);
          metricCache.set(String(media.id), metrics);
          if (!Number.isFinite(metrics.views) && !Number.isFinite(metrics.plays)) throw new Error("instagram_views_unavailable_previous_values_preserved");
          const syncedAt = new Date().toISOString();
          const update = {
            instagram_media_id: String(media.id), auto_sync: true, sync_status: "synced", last_synced_at: syncedAt, sync_error: null,
            views: metrics.views ?? metrics.plays ?? null, reach: metrics.reach ?? null, likes: metrics.likes ?? null, comments: metrics.comments ?? null,
            shares: metrics.shares ?? null, saves: metrics.saved ?? null, total_interactions: metrics.total_interactions ?? null, plays: metrics.plays ?? null,
            watch_time_ms: metrics.ig_reels_video_view_total_time ?? null, avg_watch_time_ms: metrics.ig_reels_avg_watch_time ?? null, replays: metrics.replays ?? null,
            insights_payload: { media, metrics, synced_at: syncedAt }, link_key: `instagram:${shortcode}`, link_provider: "instagram"
          };
          const { error: updateError } = await admin.from("property_marketing_events").update(update).eq("id", event.id).eq("company_id", profile.company_id);
          if (updateError) throw updateError;
          if (!countedMedia.has(String(media.id))) {
          countedMedia.add(String(media.id));
          totals.views += Number(update.views || 0);
          totals.plays += Number(update.plays || 0);
          totals.reach_non_unique += Number(update.reach || 0);
          totals.likes += Number(update.likes || 0);
          totals.comments += Number(update.comments || 0);
          totals.shares += Number(update.shares || 0);
          totals.saves += Number(update.saves || 0);
          totals.total_interactions += Number(update.total_interactions || 0);
          totals.watch_time_ms += Number(update.watch_time_ms || 0);
          totals.replays += Number(update.replays || 0);
          }
          results.push({ event_id: event.id, shortcode, media_id: String(media.id), ok: true, metrics });
        } catch (error) {
          const message = String((error as any)?.message || error).slice(0, 700);
          await admin.from("property_marketing_events").update({ auto_sync: true, sync_status: "error", last_synced_at: new Date().toISOString(), sync_error: message, link_key: `instagram:${shortcode}`, link_provider: "instagram" }).eq("id", event.id).eq("company_id", profile.company_id);
          results.push({ event_id: event.id, shortcode, ok: false, error: message });
        }
      }
      return json({ ok: true, property_id: propertyId || events[0].property_id, link_count: events.length, synced_count: results.filter((item) => item.ok).length, failed_count: results.filter((item) => !item.ok).length, totals, unique_media_count: countedMedia.size, reach_is_additive: false, links: results });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (error) {
    const message = String((error as any)?.message || error).slice(0, 1500);
    console.error("[instagram-api]", message);
    return json({ ok: false, error: "instagram_api_failed", message }, 500);
  }
});
