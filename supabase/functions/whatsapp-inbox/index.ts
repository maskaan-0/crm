import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRM_COMPANY_ID = Deno.env.get("CRM_COMPANY_ID") ?? "";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const META_GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
}

function allowedMediaUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") &&
      (u.hostname === "graph.facebook.com" || u.hostname === "lookaside.fbsbx.com" || u.hostname.endsWith(".fbsbx.com") || u.hostname.endsWith(".fbcdn.net"));
  } catch { return false; }
}
async function boundedBytes(response: Response, maxBytes: number) {
  if (Number(response.headers.get("content-length") || 0) > maxBytes) {
    await response.body?.cancel(); throw new Error("media_size_limit");
  }
  if (!response.body) throw new Error("media_unavailable");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("media_size_limit"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error("media_unavailable");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function validImageBytes(bytes: Uint8Array, mime: string) {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/png") return [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n);
  if (mime === "image/webp") return bytes.length >= 12 && [82,73,70,70].every((n,i)=>bytes[i]===n) && [87,69,66,80].every((n,i)=>bytes[i+8]===n);
  return false;
}
function imageDataUrl(bytes: Uint8Array, mime: string) {
  let binary = "";
  for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
  return `data:${mime};base64,${btoa(binary)}`;
}
async function decryptMediaToken(ciphertext: string, iv: string, companyId: string, routeKey: string) {
  const decode = (value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const seed = new TextEncoder().encode(`${META_APP_SECRET}|${companyId}|${routeKey}|habib-crm-whatsapp-v1`);
  const digest = await crypto.subtle.digest("SHA-256",seed);
  const key = await crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(iv)},key,decode(ciphertext)));
}
async function fetchImagePreview(mediaId: string, tokens: string[]) {
  for (const token of tokens) {
    const options = { headers: { Authorization: `Bearer ${token}` }, redirect: "error" as const };
    const mr = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`,{...options,signal:AbortSignal.timeout(10000)});
    if (!mr.ok) { await mr.body?.cancel(); continue; }
    const metadata = JSON.parse(new TextDecoder().decode(await boundedBytes(mr,65536)));
    const mime = String(metadata?.mime_type || "").toLowerCase();
    if (!["image/jpeg","image/png","image/webp"].includes(mime)) throw new Error("unsupported_media_type");
    if (Number(metadata?.file_size || 0) > MEDIA_MAX_BYTES) throw new Error("media_size_limit");
    if (metadata?.id && String(metadata.id)!==mediaId) throw new Error("media_unavailable");
    if (!allowedMediaUrl(String(metadata?.url || ""))) throw new Error("untrusted_media_host");
    const br = await fetch(String(metadata.url),{...options,signal:AbortSignal.timeout(20000)});
    if (!br.ok) { await br.body?.cancel(); continue; }
    const binaryMime = String(br.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (binaryMime && binaryMime !== mime && binaryMime !== "application/octet-stream") { await br.body?.cancel(); throw new Error("unsupported_media_type"); }
    const bytes = await boundedBytes(br,MEDIA_MAX_BYTES);
    if (!validImageBytes(bytes,mime)) throw new Error("unsupported_media_type");
    return {media_type:mime,data_url:imageDataUrl(bytes,mime),size_bytes:bytes.length};
  }
  throw new Error("media_unavailable");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, error: "server_not_configured" }, 503);
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "missing_auth" }, 401);

  try {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    const user = userData?.user;
    if (userError || !user) return json({ ok: false, error: "invalid_auth" }, 401);

    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("id,company_id,role,is_active,full_name").eq("id", user.id).single();
    if (profileError || !profile || profile.is_active === false) return json({ ok: false, error: "profile_not_authorized" }, 403);
    if (CRM_COMPANY_ID && profile.company_id !== CRM_COMPANY_ID) return json({ ok: false, error: "wrong_company" }, 403);
    if (!["owner","manager","agent"].includes(String(profile.role))) return json({ ok: false, error: "whatsapp_inbox_not_allowed" }, 403);

    const payload = await req.json().catch(() => ({}));
    const action = String(payload?.action || "list");
    const companyId = profile.company_id;

    const routesR = await admin.from("company_lead_routes")
      .select("route_key,owner_only_inbox").eq("company_id", companyId);
    if (routesR.error) throw new Error(`route_access_failed: ${routesR.error.message}`);
    const ownerOnly = new Set((routesR.data || []).filter((r:any)=>r.owner_only_inbox===true).map((r:any)=>String(r.route_key)));
    const staffR=await admin.from("profiles").select("phone").eq("company_id",companyId).eq("is_active",true);
    if(staffR.error)throw new Error("internal_contacts_unavailable");
    const internalWaIds=new Set((staffR.data||[]).map((p:any)=>{const digits=String(p.phone||"").replace(/\D/g,"");return digits.length===8?"968"+digits:digits.startsWith("00")?digits.slice(2):digits}).filter((phone:string)=>phone.length>=8));

    async function getConversation(conversationId: string) {
      const r = await userClient.from("whatsapp_conversations").select("*")
        .eq("id", conversationId).eq("company_id", companyId).maybeSingle();
      if (r.error) throw new Error(`conversation_lookup_failed: ${r.error.message}`);
      if (profile.role !== "owner" && ownerOnly.has(String(r.data?.route_key || ""))) return null;
      if(r.data && internalWaIds.has(String(r.data.customer_wa_id||"").replace(/\D/g,"")))return null;
      return r.data;
    }
    const pageSize = Math.min(300, Math.max(1, Math.floor(Number(payload?.limit) || 100)));

    if (action === "media") {
      const conversationId=String(payload?.conversation_id||"").trim(), messageId=String(payload?.message_id||"").trim();
      if (!conversationId || !messageId) return json({ok:false,error:"conversation_message_required"},400);
      // Caller RLS and owner-only authorization precede all credential reads/Meta access.
      const conversation=await getConversation(conversationId);
      if (!conversation) return json({ok:false,error:"conversation_not_found"},404);
      const message=await userClient.from("whatsapp_messages").select("id,media_id,direction,message_type")
        .eq("company_id",companyId).eq("conversation_id",conversationId).eq("id",messageId).maybeSingle();
      if (message.error || !message.data) return json({ok:false,error:"message_not_found"},404);
      if (message.data.direction!=="inbound" || message.data.message_type!=="image" || !/^\d{1,40}$/.test(String(message.data.media_id||"")))
        return json({ok:false,error:"inbound_image_required"},400);
      try {
        const tokens:string[]=[];
        const credential=await admin.from("whatsapp_route_credentials").select("token_ciphertext,token_iv,expires_at")
          .eq("company_id",companyId).eq("route_key",String(conversation.route_key||"")).maybeSingle();
        if (credential.error) throw new Error("media_credentials_unavailable");
        if (credential.data && META_APP_SECRET && (!credential.data.expires_at || Date.parse(credential.data.expires_at)>Date.now()+60000)) {
          try { tokens.push(await decryptMediaToken(credential.data.token_ciphertext,credential.data.token_iv,companyId,String(conversation.route_key||""))); }
          catch { /* The existing server credential may still read this route's media. */ }
        }
        if (WHATSAPP_ACCESS_TOKEN && !tokens.includes(WHATSAPP_ACCESS_TOKEN)) tokens.push(WHATSAPP_ACCESS_TOKEN);
        if (!tokens.length) throw new Error("media_credentials_unavailable");
        const preview=await fetchImagePreview(String(message.data.media_id),tokens);
        // A permission revoked during download must not release the media afterwards.
        if (!await getConversation(conversationId)) return json({ok:false,error:"conversation_not_found"},404);
        return json({ok:true,message_id:message.data.id,...preview});
      } catch (error) {
        const code=String((error as Error)?.message||"");
        const allowed=["media_size_limit","unsupported_media_type","untrusted_media_host","media_credentials_unavailable","media_unavailable"];
        return json({ok:false,error:allowed.includes(code)?code:"media_unavailable",message:"تعذر عرض الصورة بأمان. راجع الصورة في واتساب الأصلي قبل تحديد العقار."},code==="media_size_limit"?413:502);
      }
    }

    if (action === "list") {
      const offset = Math.max(0, Math.min(100000, Math.floor(Number(payload?.offset) || 0)));
      // RLS filters the user's accessible rows BEFORE pagination.
      let q = userClient.from("whatsapp_conversations")
        .select("id,client_id,route_key,assigned_to,meta_phone_number_id,inbound_number,customer_wa_id,customer_phone,customer_name,status,unread_count,last_message_at,last_inbound_at,last_outbound_at,ai_summary,human_handoff_required,handoff_reason,handoff_updated_at,last_automation_action,updated_at")
        .eq("company_id", companyId);
      if (profile.role !== "owner" && ownerOnly.size) q = q.not("route_key", "in", `(${[...ownerOnly].join(",")})`);
      if(internalWaIds.size)q=q.not("customer_wa_id","in",`(${[...internalWaIds].join(",")})`);
      const r = await q.order("last_message_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false }).range(offset, offset + pageSize);
      if (r.error) throw new Error(`conversation_list_failed: ${r.error.message}`);
      const hasMore = (r.data || []).length > pageSize;
      const conversations = (r.data || []).slice(0, pageSize);
      const clientIds = [...new Set(conversations.map((c:any)=>c.client_id).filter(Boolean))];
      const clientsMap: Record<string, any> = {};
      if (clientIds.length) {
        const cr = await userClient.from("clients")
          .select("id,name,phone,phone_normalized,preferred_area,lead_temperature,status,pipeline_stage,assigned_to")
          .eq("company_id", companyId).in("id", clientIds);
        if (cr.error) throw new Error(`client_list_failed: ${cr.error.message}`);
        for (const c of cr.data || []) clientsMap[c.id] = c;
      }
      const counters = await userClient.rpc("crm_whatsapp_inbox_counts");
      if (counters.error) throw new Error(`inbox_counts_failed: ${counters.error.message}`);
      const counts = Array.isArray(counters.data) ? counters.data[0] : counters.data;
      if(internalWaIds.size){
        const hidden=await userClient.from("whatsapp_conversations").select("unread_count,human_handoff_required").eq("company_id",companyId).in("customer_wa_id",[...internalWaIds]);
        if(hidden.error)throw new Error("internal_counts_failed");
        counts.unread_total=Math.max(0,Number(counts.unread_total||0)-(hidden.data||[]).reduce((n:any,c:any)=>n+Number(c.unread_count||0),0));
        counts.handoff_total=Math.max(0,Number(counts.handoff_total||0)-(hidden.data||[]).filter((c:any)=>c.human_handoff_required).length);
      }
      const previews = await userClient.rpc("crm_whatsapp_latest_messages", { p_conversation_ids: conversations.map((c:any)=>c.id) });
      if (previews.error) throw new Error(`message_previews_failed: ${previews.error.message}`);
      const latestMap: Record<string, any> = {};
      for (const m of previews.data || []) latestMap[m.conversation_id] = m;
      return json({ ok:true,
        conversations:conversations.map((c:any)=>({...c,client:c.client_id?clientsMap[c.client_id]||null:null,last_message:latestMap[c.id]||null})),
        has_more:hasMore,next_offset:hasMore?offset+pageSize:null,
        unread_total:Number(counts?.unread_total||0),handoff_total:Number(counts?.handoff_total||0) });
    }

    if (action === "messages") {
      const conversationId = String(payload?.conversation_id || "").trim();
      if (!conversationId) return json({ ok:false,error:"conversation_id_required" },400);
      const conversation = await getConversation(conversationId);
      if (!conversation) return json({ ok:false,error:"conversation_not_found" },404);
      let mq = userClient.from("whatsapp_messages")
        .select("id,conversation_id,client_id,request_id,sent_by_user_id,actor_type,channel_source,whatsapp_message_id,direction,message_type,sender_wa_id,recipient_wa_id,body,transcript,transcription_status,automation_result,media_id,reply_to_message_id,message_timestamp,created_at,ingestion_seq,delivery_status,processing_error,ai_processed_at,matched_property_id,property_match_status")
        .eq("company_id",companyId).eq("conversation_id",conversationId);
      const beforeId = String(payload?.before_message_id || "").trim();
      if (beforeId) {
        const cursor = await userClient.from("whatsapp_messages").select("id,message_timestamp")
          .eq("id",beforeId).eq("company_id",companyId).eq("conversation_id",conversationId).maybeSingle();
        if (cursor.error || !cursor.data) return json({ok:false,error:"invalid_message_cursor"},400);
        mq = mq.or(`message_timestamp.lt.${cursor.data.message_timestamp},and(message_timestamp.eq.${cursor.data.message_timestamp},id.lt.${cursor.data.id})`);
      }
      const mr = await mq.order("message_timestamp",{ascending:false}).order("id",{ascending:false}).limit(pageSize+1);
      if (mr.error) throw new Error(`messages_failed: ${mr.error.message}`);
      const hasMore = (mr.data||[]).length>pageSize;
      const pageMessages = (mr.data||[]).slice(0,pageSize);
      const nextBefore = hasMore ? pageMessages[pageMessages.length-1]?.id || null : null;
      const readThrough = [...pageMessages].sort((a:any,b:any)=>
        Number(b.ingestion_seq||0)-Number(a.ingestion_seq||0) || String(b.id).localeCompare(String(a.id)))[0]?.id || null;
      const messages = pageMessages.reverse();
      let client:any=null, requests:any[]=[];
      if (conversation.client_id) {
        const cr=await userClient.from("clients").select("id,name,phone,phone_normalized,email,preferred_area,lead_temperature,status,pipeline_stage,assigned_to").eq("company_id",companyId).eq("id",conversation.client_id).maybeSingle();
        client=cr.data||null;
        let rrq=userClient.from("client_requests")
          .select("id,request_type,property_type,property_types,preferred_area,preferred_areas,alternative_areas,wilayat,budget_min,budget_max,payment_method,financing_readiness,purchase_timing,purpose,bedrooms_min,bathrooms_min,must_haves,flexible_preferences,decision_maker_status,search_status,next_action,next_followup,status,pipeline_stage,priority,route_key,branch_key,assigned_to,closed_reason,needs_human_review,first_human_response_at,first_mutual_dialogue_at,requirements_completed_at,qualified_at,first_match_sent_at,first_appointment_booked_at,first_appointment_confirmed_at,first_attended_at,serious_interest_at,opportunity_opened_at,negotiation_started_at,deposit_paid_at,contract_completed_at,closed_won_at,last_mutual_contact_at,updated_at")
          .eq("company_id",companyId).eq("client_id",conversation.client_id).order("updated_at",{ascending:false}).limit(20);
        const rr=await rrq;
        if (rr.error) throw new Error(`requests_failed: ${rr.error.message}`);
        requests=rr.data||[];

      }
      const ar=await userClient.from("whatsapp_automation_events").select("id,message_id,property_id,viewing_id,deal_id,action_type,status,confidence,reason,payload,created_at,applied_at").eq("company_id",companyId).eq("conversation_id",conversationId).order("created_at",{ascending:false}).limit(50);
      if (ar.error) throw new Error(`automation_events_failed: ${ar.error.message}`);
      return json({ok:true,conversation,client,requests,messages,automation_events:ar.data||[],
        has_more:hasMore,next_before:nextBefore,read_through_message_id:readThrough});
    }

    if (action === "link_message_request") {
      const conversationId=String(payload?.conversation_id||"").trim(), messageId=String(payload?.message_id||"").trim(), requestId=String(payload?.request_id||"").trim();
      if(!conversationId||!messageId||!requestId)return json({ok:false,error:"conversation_message_request_required"},400);
      const conversation=await getConversation(conversationId);if(!conversation)return json({ok:false,error:"conversation_not_found"},404);
      const rr=await admin.from("client_requests").select("id,client_id,assigned_to").eq("id",requestId).eq("company_id",companyId).eq("client_id",conversation.client_id).maybeSingle();
      if(rr.error||!rr.data)return json({ok:false,error:"request_not_found"},404);
      if(profile.role==="agent" && rr.data.assigned_to!==user.id){
        const a=await admin.from("client_request_assignees").select("request_id").eq("company_id",companyId).eq("request_id",requestId).eq("user_id",user.id).maybeSingle();
        if(a.error||!a.data)return json({ok:false,error:"request_not_authorized"},403);
      }
      const mr=await admin.from("whatsapp_messages").select("id,direction").eq("id",messageId).eq("company_id",companyId).eq("conversation_id",conversationId).maybeSingle();
      if(mr.error||!mr.data)return json({ok:false,error:"message_not_found"},404);
      const ur=await admin.from("whatsapp_messages").update({request_id:requestId}).eq("id",messageId).eq("company_id",companyId);if(ur.error)throw new Error(`message_request_link_failed: ${ur.error.message}`);
      return json({ok:true,request_id:requestId});
    }

    if (action === "mark_read") return json({ok:false,error:"phone_read_state_not_available"},409);

    if (action === "clear_handoff") {
      const conversationId=String(payload?.conversation_id||"").trim();if(!conversationId)return json({ok:false,error:"conversation_id_required"},400);
      const conversation=await getConversation(conversationId);if(!conversation)return json({ok:false,error:"conversation_not_found"},404);
      const ur=await admin.from("whatsapp_conversations").update({human_handoff_required:false,handoff_reason:null,handoff_updated_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",conversationId).eq("company_id",companyId);if(ur.error)throw new Error(`clear_handoff_failed: ${ur.error.message}`);
      return json({ok:true});
    }

    return json({ok:false,error:"unknown_action"},400);
  } catch (err) {
    console.error("[whatsapp-inbox]",err);
    return json({ok:false,error:"internal_error",message:String((err as any)?.message||err).slice(0,1200)},500);
  }
});
