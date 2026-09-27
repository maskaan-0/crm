import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.6-luna";
const OPENAI_TRANSCRIBE_MODEL = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-mini-transcribe";
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const META_GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
// Remains disabled until the approved scenario rollout is explicitly enabled.
const AUTOMATION_ENGINE_ENABLED = false;
const AUTO_WHATSAPP_DETAILS_REPLY = (Deno.env.get("AUTO_WHATSAPP_DETAILS_REPLY") || "false").toLowerCase() === "true";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function short(value: unknown, max = 4000) {
  const s = String(value ?? "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function cleanDigits(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
function omanNowText() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Muscat", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

async function transcribeAudio(mediaId: string) {
  if (!mediaId || !WHATSAPP_ACCESS_TOKEN || !OPENAI_API_KEY) throw new Error("audio_transcription_not_configured");
  const metaRes = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta?.url) throw new Error(meta?.error?.message || `media_lookup_${metaRes.status}`);
  const mediaRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } });
  if (!mediaRes.ok) throw new Error(`media_download_${mediaRes.status}`);
  const blob = await mediaRes.blob();
  const mime = meta?.mime_type || blob.type || "audio/ogg";
  const ext = mime.includes("mpeg") ? "mp3" : mime.includes("mp4") ? "m4a" : mime.includes("wav") ? "wav" : "ogg";
  const form = new FormData();
  form.append("file", blob, `voice.${ext}`);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const payload = await tr.json().catch(() => ({}));
  if (!tr.ok) throw new Error(payload?.error?.message || `transcription_${tr.status}`);
  return short(payload?.text, 6000);
}

async function getRecentConversation(conversationId: string, beforeMessageAt: string | null) {
  let q = admin.from("whatsapp_messages")
    .select("id,direction,message_type,body,transcript,message_timestamp,matched_property_id,reply_to_message_id,actor_type")
    .eq("conversation_id", conversationId)
    .order("message_timestamp", { ascending: false })
    .limit(16);
  if (beforeMessageAt) q = q.lte("message_timestamp", beforeMessageAt);
  const r = await q;
  if (r.error) throw new Error(`recent_messages:${r.error.message}`);
  return (r.data || []).reverse();
}

async function resolvePropertyContext(message: any, recent: any[]) {
  if (message.matched_property_id) return { property_id: message.matched_property_id, source: "current_message", ambiguous: false };
  if (message.reply_to_message_id) {
    const rr = await admin.from("whatsapp_messages").select("matched_property_id")
      .eq("whatsapp_message_id", message.reply_to_message_id).maybeSingle();
    if (!rr.error && rr.data?.matched_property_id) return { property_id: rr.data.matched_property_id, source: "reply_context", ambiguous: false };
  }
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const ids: string[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const x = recent[i];
    const t = x.message_timestamp ? new Date(x.message_timestamp).getTime() : 0;
    if (t && t < cutoff) continue;
    if (x.matched_property_id && !ids.includes(x.matched_property_id)) ids.push(x.matched_property_id);
  }
  if (ids.length === 1) return { property_id: ids[0], source: "recent_conversation", ambiguous: false };
  if (ids.length > 1) return { property_id: null, source: "recent_conversation", ambiguous: true };
  return { property_id: null, source: "none", ambiguous: false };
}

async function resolveRequestId(clientId: string, propertyId: string | null) {
  if (propertyId) {
    const pi = await admin.from("property_inquiries").select("request_id,updated_at")
      .eq("client_id", clientId).eq("property_id", propertyId).not("request_id", "is", null)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!pi.error && pi.data?.request_id) return pi.data.request_id;
  }
  const rq = await admin.from("client_requests").select("id").eq("client_id", clientId)
    .in("status", ["active","paused"]).order("updated_at", { ascending: false }).limit(2);
  if (!rq.error && (rq.data || []).length === 1) return rq.data![0].id;
  return null;
}

async function getProperty(propertyId: string | null) {
  if (!propertyId) return null;
  const r = await admin.from("properties").select("id,title,area,wilayat,price,bedrooms,bathrooms,land_size,built_size,public_details,map_url,status")
    .eq("id", propertyId).maybeSingle();
  if (r.error) throw new Error(`property:${r.error.message}`);
  return r.data || null;
}

async function getRecentViewings(clientId: string, propertyId: string | null) {
  let q = admin.from("viewings").select("id,property_id,request_id,agent_id,viewing_date,viewing_time,status,client_feedback,pipeline_outcome,rejection_reason,outcome_note,created_at")
    .eq("client_id", clientId).eq("archived", false)
    .order("viewing_date", { ascending: false }).limit(8);
  if (propertyId) q = q.eq("property_id", propertyId);
  const r = await q;
  if (r.error) throw new Error(`viewings:${r.error.message}`);
  return r.data || [];
}

const actionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["none","schedule_viewing","reschedule_viewing","cancel_viewing","post_visit_feedback","start_negotiation","property_details","human_handoff"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_human_review: { type: "boolean" },
    reason: { type: "string" },
    viewing_date: { type: ["string","null"] },
    viewing_time: { type: ["string","null"] },
    feedback: { type: ["string","null"], enum: ["liked","disliked","hesitant","wants_negotiate",null] },
    pipeline_outcome: { type: ["string","null"], enum: ["negotiation","lost",null] },
    rejection_reason: { type: ["string","null"], enum: ["price","location","area","room_layout","design","finishing","parking","financing","found_other","not_interested","not_serious","no_response","other",null] },
    detail: { type: "string" },
    followup_date: { type: ["string","null"] },
    handoff_reason: { type: ["string","null"] },
  },
  required: ["action","confidence","needs_human_review","reason","viewing_date","viewing_time","feedback","pipeline_outcome","rejection_reason","detail","followup_date","handoff_reason"],
};

async function classifyAction(args: { text: string; recent: any[]; property: any; propertyContext: any; viewings: any[] }) {
  if (!OPENAI_API_KEY || !args.text.trim()) return null;
  const recentLines = args.recent.map((m: any) => {
    const speaker = m.direction === "inbound" ? "CUSTOMER" : (m.actor_type === "human" ? "STAFF" : "SYSTEM");
    return `${speaker}: ${short(m.transcript || m.body || `[${m.message_type}]`, 800)}`;
  }).join("\n");
  const instructions = `You are the WhatsApp workflow classifier for Maskaan_0 in Oman. Decide ONE operational action from the conversation.\n\nRules:\n- Use the recent conversation, not only the last message. A customer saying \"yes\" may confirm a date/time proposed by staff in the previous turn.\n- A viewing can be auto-scheduled only when the target property is unambiguous AND a date and time are clearly agreed. If either is unclear, action=human_handoff.\n- A voice-note transcript is treated exactly like a written customer message.\n- After a completed viewing, explicit bargaining such as \"كم آخركم\", \"آخر سعر\", \"ينزل؟\", a concrete offer, or asking to negotiate means start_negotiation.\n- Before a completed viewing, merely asking \"كم آخركم\" is NOT enough for automatic pipeline movement. Use human_handoff unless there is a concrete offer/commitment.\n- Negative post-visit feedback means post_visit_feedback with pipeline_outcome=lost and the closest rejection_reason. Preserve the customer's exact reason in detail.\n- If the customer likes the property but says they will think, use post_visit_feedback with feedback=hesitant and pipeline_outcome=null.\n- A request to visit, choose a visit time, change a visit time, or cancel a visit must never receive a blind automated reply; schedule/update the viewing when all facts are clear, otherwise hand off to staff.\n- property_details means the customer only asks for factual details/location/price/specifications and does not ask to visit, negotiate, reserve, or make a decision.\n- Never invent a property, date, time, rejection reason, or customer intent.\n- Dates are local Oman time (Asia/Muscat). Return viewing_date and followup_date as YYYY-MM-DD, viewing_time as HH:MM 24-hour time.\n- If there is more than one possible property context, needs_human_review=true and action=human_handoff.`;
  const input = JSON.stringify({
    oman_now: omanNowText(),
    customer_latest_text: args.text,
    recent_conversation: recentLines,
    property_context: args.property ? { id: args.property.id, title: args.property.title, area: args.property.area, price: args.property.price } : null,
    property_context_source: args.propertyContext,
    recent_viewings: args.viewings,
  });
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      reasoning: { effort: "low" },
      instructions,
      input,
      text: { format: { type: "json_schema", name: "whatsapp_crm_action", strict: true, schema: actionSchema } },
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error?.message || `OpenAI_${res.status}`);
  const text = payload?.output_text || payload?.output?.flatMap((x: any) => x?.content || []).find((x: any) => x?.type === "output_text")?.text;
  if (!text) throw new Error("no_action_output");
  return JSON.parse(text);
}

async function setHandoff(conversationId: string, required: boolean, reason: string | null, action: any) {
  await admin.from("whatsapp_conversations").update({
    human_handoff_required: required,
    handoff_reason: required ? short(reason, 500) : null,
    handoff_updated_at: new Date().toISOString(),
    last_automation_action: action,
    updated_at: new Date().toISOString(),
  }).eq("id", conversationId);
}

async function logEvent(row: any) {
  const r = await admin.from("whatsapp_automation_events").insert(row).select("id").single();
  if (r.error) throw new Error(`automation_event:${r.error.message}`);
  return r.data?.id;
}

async function sendAutomatedDetails(args: { message: any; conversation: any; client: any; requestId: string | null; property: any }) {
  if (!AUTO_WHATSAPP_DETAILS_REPLY) return { sent: false, reason: "auto_reply_disabled" };
  if (!WHATSAPP_ACCESS_TOKEN) return { sent: false, reason: "whatsapp_token_missing" };
  if (!args.property?.public_details) return { sent: false, reason: "public_details_missing" };
  const phoneNumberId = cleanDigits(args.conversation.meta_phone_number_id);
  const to = cleanDigits(args.client.phone);
  if (!phoneNumberId || !to) return { sent: false, reason: "phone_context_missing" };
  const parts = [args.property.public_details];
  if (args.property.map_url) parts.push(`📍 الموقع: ${args.property.map_url}`);
  const body = short(parts.join("\n\n"), 4000);
  const graph = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body } }),
  });
  const payload = await graph.json().catch(() => ({}));
  if (!graph.ok) throw new Error(payload?.error?.message || `meta_send_${graph.status}`);
  const wamid = payload?.messages?.[0]?.id;
  const now = new Date().toISOString();
  if (wamid) {
    await admin.from("whatsapp_messages").insert({
      company_id: args.message.company_id,
      conversation_id: args.conversation.id,
      client_id: args.client.id,
      request_id: args.requestId,
      whatsapp_message_id: wamid,
      direction: "outbound",
      message_type: "text",
      sender_wa_id: phoneNumberId,
      recipient_wa_id: to,
      body,
      message_timestamp: now,
      delivery_status: "sent",
      actor_type: "automated",
      channel_source: "crm_automation",
      raw_payload: { source: "property_details_auto_reply", property_id: args.property.id },
    });
  }
  return { sent: true, message_id: wamid || null };
}

async function applyAction(args: { action: any; message: any; conversation: any; client: any; property: any; propertyContext: any; requestId: string | null; viewings: any[] }) {
  const a = args.action;
  const baseEvent: any = {
    company_id: args.message.company_id,
    conversation_id: args.conversation.id,
    message_id: args.message.id,
    client_id: args.client.id,
    request_id: args.requestId,
    property_id: args.property?.id || null,
    action_type: a.action,
    confidence: a.confidence,
    reason: short(a.reason, 1000),
    payload: a,
  };
  if (a.action === "none") {
    await logEvent({ ...baseEvent, status: "skipped" });
    // An unrelated message must not clear an unresolved human handoff.
    return { status: "skipped" };
  }
  if (args.propertyContext?.ambiguous || a.needs_human_review || a.action === "human_handoff" || !Number.isFinite(Number(a.confidence)) || Number(a.confidence) < 0.82) {
    await logEvent({ ...baseEvent, status: "pending_review" });
    await setHandoff(args.conversation.id, true, a.handoff_reason || a.reason || "يحتاج تدخل بشري", a);
    return { status: "pending_review" };
  }
  if (["schedule_viewing","reschedule_viewing","cancel_viewing","post_visit_feedback","start_negotiation","property_details"].includes(a.action) && !args.property?.id) {
    await logEvent({ ...baseEvent, status: "pending_review", reason: "تعذر تحديد العقار بشكل آمن" });
    await setHandoff(args.conversation.id, true, "تعذر تحديد العقار من المحادثة", a);
    return { status: "pending_review" };
  }

  if (["schedule_viewing","reschedule_viewing","property_details"].includes(a.action) && ["sold","not_available"].includes(String(args.property?.status))) {
    await logEvent({...baseEvent,status:"pending_review",reason:"العقار غير متاح للعرض التلقائي"});
    await setHandoff(args.conversation.id,true,"راجع توفر العقار قبل المتابعة",a);
    return {status:"pending_review"};
  }
  if (["schedule_viewing","reschedule_viewing"].includes(a.action)) {
    const date=String(a.viewing_date||""),time=String(a.viewing_time||"");
    const scheduledAt=new Date(`${date}T${time}:00+04:00`).getTime();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isFinite(scheduledAt)||scheduledAt<Date.now()||new Date(scheduledAt+4*3600000).toISOString().slice(0,10)!==date){
      await logEvent({...baseEvent,status:"pending_review",reason:"تاريخ أو وقت الزيارة غير صالح أو مضى"});
      await setHandoff(args.conversation.id,true,"يحتاج موعد الزيارة إلى تأكيد صحيح",a);
      return {status:"pending_review"};
    }
  }
  if (["schedule_viewing","reschedule_viewing","cancel_viewing"].includes(a.action) && args.viewings.filter((v:any)=>["scheduled","postponed"].includes(v.status)).length>1) {
    await logEvent({...baseEvent,status:"pending_review",reason:"توجد زيارات متعددة ويجب تحديد الزيارة المطلوبة"});
    await setHandoff(args.conversation.id,true,"تعذر تحديد الزيارة بأمان",a);
    return {status:"pending_review"};
  }
  if (a.action === "schedule_viewing") {
    if (!a.viewing_date || !a.viewing_time || a.confidence < 0.82) {
      await logEvent({ ...baseEvent, status: "pending_review", reason: "موعد الزيارة غير مكتمل أو الثقة منخفضة" });
      await setHandoff(args.conversation.id, true, "موعد الزيارة يحتاج تأكيد التاريخ/الوقت", a);
      return { status: "pending_review" };
    }
    const existing = args.viewings.find((v: any) => ["scheduled","postponed"].includes(v.status));
    let vr: any;
    if (existing) {
      vr = await admin.from("viewings").update({
        viewing_date: a.viewing_date,
        viewing_time: a.viewing_time,
        status: "scheduled",
        request_id: existing.request_id || args.requestId,
        created_via: "whatsapp_ai",
        source_whatsapp_message_id: args.message.id,
        auto_confidence: a.confidence,
        notes: short(a.detail || a.reason, 1500),
      }).eq("id", existing.id).select("id").single();
    } else {
      vr = await admin.from("viewings").insert({
        company_id: args.message.company_id,
        client_id: args.client.id,
        property_id: args.property.id,
        agent_id: args.conversation.assigned_to || null,
        request_id: args.requestId,
        viewing_date: a.viewing_date,
        viewing_time: a.viewing_time,
        duration_minutes: 60,
        location: args.property.map_url || args.property.area || null,
        status: "scheduled",
        created_via: "whatsapp_ai",
        source_whatsapp_message_id: args.message.id,
        auto_confidence: a.confidence,
        notes: short(a.detail || a.reason, 1500),
      }).select("id").single();
    }
    if (vr.error) throw new Error(`schedule_viewing:${vr.error.message}`);
    await logEvent({ ...baseEvent, status: "applied", viewing_id: vr.data.id, applied_at: new Date().toISOString() });
    await setHandoff(args.conversation.id, false, null, a);
    return { status: "applied", viewing_id: vr.data.id };
  }

  if (a.action === "reschedule_viewing" || a.action === "cancel_viewing") {
    const existing = args.viewings.find((v: any) => ["scheduled","postponed"].includes(v.status));
    if (!existing) {
      await logEvent({ ...baseEvent, status: "pending_review", reason: "لا توجد زيارة مفتوحة لتعديلها" });
      await setHandoff(args.conversation.id, true, "لا توجد زيارة مجدولة واضحة للتعديل", a);
      return { status: "pending_review" };
    }
    const patch: any = { source_whatsapp_message_id: args.message.id, created_via: "whatsapp_ai", auto_confidence: a.confidence };
    if (a.action === "cancel_viewing") {
      patch.status = "cancelled";
      patch.notes = short(a.detail || a.reason, 1500);
    } else {
      if (!a.viewing_date || !a.viewing_time) {
        await logEvent({ ...baseEvent, status: "pending_review", viewing_id: existing.id, reason: "موعد إعادة الجدولة غير مكتمل" });
        await setHandoff(args.conversation.id, true, "إعادة الجدولة تحتاج تاريخ ووقت واضحين", a);
        return { status: "pending_review" };
      }
      patch.status = "scheduled";
      patch.viewing_date = a.viewing_date;
      patch.viewing_time = a.viewing_time;
      patch.notes = short(a.detail || a.reason, 1500);
    }
    const ur = await admin.from("viewings").update(patch).eq("id", existing.id);
    if (ur.error) throw new Error(`viewing_update:${ur.error.message}`);
    await logEvent({ ...baseEvent, status: "applied", viewing_id: existing.id, applied_at: new Date().toISOString() });
    await setHandoff(args.conversation.id, false, null, a);
    return { status: "applied", viewing_id: existing.id };
  }

  if (a.action === "post_visit_feedback" || a.action === "start_negotiation") {
    const existing = args.viewings.find((v: any) => v.status === "done");
    if (!existing) {
      await logEvent({ ...baseEvent, status: "pending_review", reason: "لا توجد زيارة مرتبطة واضحة" });
      await setHandoff(args.conversation.id, true, "تم فهم رأي/تفاوض لكن لا توجد زيارة واضحة مرتبطة", a);
      return { status: "pending_review" };
    }
    const outcome = a.action === "start_negotiation" ? "negotiation" : a.pipeline_outcome;
    const feedback = a.action === "start_negotiation" ? "wants_negotiate" : a.feedback;
    const patch: any = {
      // Keep the already-confirmed visit status and attendance unchanged.
      client_feedback: feedback || (outcome === "lost" ? "disliked" : null),
      pipeline_outcome: outcome || null,
      rejection_reason: outcome === "lost" ? (a.rejection_reason || "other") : null,
      outcome_note: short(a.detail || a.reason, 2000),
      next_step: outcome === "negotiation" ? "متابعة التفاوض" : (a.followup_date ? "متابعة العميل" : null),
      followup_date: a.followup_date || null,
      source_whatsapp_message_id: args.message.id,
      created_via: "whatsapp_ai",
      auto_confidence: a.confidence,
    };
    Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
    const ur = await admin.from("viewings").update(patch).eq("id", existing.id);
    if (ur.error) throw new Error(`post_visit:${ur.error.message}`);
    await logEvent({ ...baseEvent, status: "applied", viewing_id: existing.id, applied_at: new Date().toISOString() });
    await setHandoff(args.conversation.id, outcome === "negotiation", outcome === "negotiation" ? "العميل دخل مرحلة تفاوض ويحتاج تدخل بشري" : false as any, a);
    return { status: "applied", viewing_id: existing.id, pipeline_outcome: outcome };
  }

  if (a.action === "property_details") {
    const sent = await sendAutomatedDetails(args);
    if (!sent.sent) {
      const needsHuman = sent.reason !== "auto_reply_disabled";
      await logEvent({ ...baseEvent, status: needsHuman ? "pending_review" : "detected", reason: sent.reason });
      await setHandoff(args.conversation.id, needsHuman, needsHuman ? "تفاصيل العقار غير مكتملة للإرسال الآلي" : null, a);
      return { status: needsHuman ? "pending_review" : "detected", ...sent };
    }
    await logEvent({ ...baseEvent, status: "applied", applied_at: new Date().toISOString() });
    await setHandoff(args.conversation.id, false, null, a);
    return { status: "applied", ...sent };
  }

  await logEvent({ ...baseEvent, status: "skipped" });
  return { status: "skipped" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) return json({ ok: false, error: "server_not_configured" }, 503);
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "missing_auth" }, 401);
  const token = auth.slice(7);
  if (token !== SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, error: "not_authorized" }, 403);
  if (!AUTOMATION_ENGINE_ENABLED) return json({ ok: true, ignored: true, reason: "automation_engine_disabled" });
  const body = await req.json().catch(() => ({}));
  const messageId = String(body?.message_id || "").trim();
  if (!messageId) return json({ ok: false, error: "message_id_required" }, 400);
  try {
    const mr = await admin.from("whatsapp_messages")
      .select("id,company_id,conversation_id,client_id,request_id,direction,message_type,body,media_id,reply_to_message_id,message_timestamp,matched_property_id,transcript,transcription_status,automation_result")
      .eq("id", messageId).single();
    if (mr.error || !mr.data) return json({ ok: false, error: "message_not_found" }, 404);
    const message: any = mr.data;
    if (message.direction !== "inbound" || !message.client_id) return json({ ok: true, ignored: true });
    if (message.automation_result) return json({ok:true,ignored:true,reason:"message_already_processed"});
    const runtime=await admin.from("whatsapp_automation_runtime").select("mode,allowed_customer_phones,enabled_scenarios,allowed_routes").eq("company_id",message.company_id).maybeSingle();
    if(runtime.error||runtime.data?.mode!=="test"||!runtime.data?.enabled_scenarios?.includes("viewing_workflow_v1")) return json({ok:true,ignored:true,reason:"scenario_not_enabled"});

    let effectiveText = short(message.transcript || message.body, 6000);
    if (message.message_type === "audio" && !effectiveText) {
      await admin.from("whatsapp_messages").update({ transcription_status: "pending" }).eq("id", message.id);
      try {
        effectiveText = await transcribeAudio(message.media_id);
        await admin.from("whatsapp_messages").update({ transcript: effectiveText, transcription_status: "completed" }).eq("id", message.id);
      } catch (e) {
        await admin.from("whatsapp_messages").update({ transcription_status: "failed", processing_error: short((e as any)?.message || e, 1500) }).eq("id", message.id);
        throw e;
      }
    } else if (message.message_type !== "audio" && !message.transcription_status) {
      await admin.from("whatsapp_messages").update({ transcription_status: "not_applicable" }).eq("id", message.id);
    }
    if (!effectiveText) return json({ ok: true, ignored: true, reason: "no_text_content" });

    const cr = await admin.from("whatsapp_conversations").select("*").eq("id", message.conversation_id).single();
    if (cr.error) throw new Error(`conversation:${cr.error.message}`);
    const conversation: any = cr.data;
    if(conversation.human_handoff_required)return json({ok:true,ignored:true,reason:"human_handoff_open"});
    const clr = await admin.from("clients").select("id,name,phone").eq("id", message.client_id).single();
    if (clr.error) throw new Error(`client:${clr.error.message}`);
    const client: any = clr.data;
    const allowedPhones=Array.isArray(runtime.data?.allowed_customer_phones)?runtime.data.allowed_customer_phones.map(cleanDigits):[];
    if(!allowedPhones.includes(cleanDigits(client.phone))||!runtime.data?.allowed_routes?.includes(conversation.route_key))return json({ok:true,ignored:true,reason:"outside_test_scope"});

    const recent = await getRecentConversation(message.conversation_id, message.message_timestamp);
    const propertyContext = await resolvePropertyContext(message, recent);
    const property = await getProperty(propertyContext.property_id);
    const requestId = message.request_id || await resolveRequestId(client.id, property?.id || null);
    const viewings = await getRecentViewings(client.id, property?.id || null);
    const action = await classifyAction({ text: effectiveText, recent, property, propertyContext, viewings });
    if (!action) return json({ ok: true, ignored: true, reason: "no_classifier" });

    const result = await applyAction({ action, message, conversation, client, property, propertyContext, requestId, viewings });
    await admin.from("whatsapp_messages").update({ automation_result: { action, result }, request_id: message.request_id || requestId || null }).eq("id", message.id);
    return json({ ok: true, text: effectiveText, property_context: propertyContext, action, result });
  } catch (e) {
    return json({ ok: false, error: "automation_failed", message: short((e as any)?.message || e, 1800) }, 500);
  }
});

