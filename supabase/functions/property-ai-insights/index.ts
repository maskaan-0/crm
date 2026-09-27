import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.6-luna";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });
}

const insightSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    diagnosis: { type: "string" },
    priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
    price_action: { type: "string" },
    photography_action: { type: "string" },
    finishing_action: { type: "string" },
    marketing_action: { type: "string" },
    owner_discussion: { type: "string" },
    evidence: { type: "array", maxItems: 8, items: { type: "string" } },
    next_steps: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["headline","diagnosis","priority","price_action","photography_action","finishing_action","marketing_action","owner_discussion","evidence","next_steps","confidence"]
};

function latestIso(values: Array<string | null | undefined>): string | null {
  const valid = values.filter(Boolean).map(String).filter(v => !Number.isNaN(new Date(v).getTime()));
  if (!valid.length) return null;
  return valid.sort((a,b) => new Date(b).getTime() - new Date(a).getTime())[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ ok: false, error: "server_not_configured" }, 503);
  if (!OPENAI_API_KEY) return json({ ok: false, error: "openai_not_configured" }, 503);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ ok: false, error: "missing_auth" }, 401);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authHeader.slice(7);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return json({ ok: false, error: "invalid_auth" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const propertyId = String(body?.property_id || "");
  if (!propertyId) return json({ ok: false, error: "property_id_required" }, 400);

  const [propertyR, inquiriesR, viewingsR, rejectionsR, marketingR, dealsR] = await Promise.all([
    supabase.from("crm_properties_access").select("id,company_id,title,property_code,internal_name,branch_key,type,area,wilayat,price,owner_net,bedrooms,bathrooms,land_size,built_size,status,description,created_at,updated_at,performance_tracking_started_at,photography_status,photography_reason,photography_required_at,photography_completed_at,marketing_review_status,marketing_reviewed_at,marketing_review_note").eq("id", propertyId).single(),
    supabase.from("property_inquiries").select("id,client_id,request_id,source,status,first_inquiry_at,last_inquiry_at,inquiry_count,rejection_reason,rejection_notes,last_message,match_status,match_notes,client_response,viewing_booked,viewing_completed,post_visit_interest,outcome,has_inbound_inquiry").eq("property_id", propertyId).order("last_inquiry_at", { ascending: false }).limit(100),
    supabase.from("viewings").select("id,client_id,request_id,viewing_date,status,attendance,client_feedback,rejection_reason,liked,next_step,notes").eq("property_id", propertyId).eq("archived", false).order("viewing_date", { ascending: false }).limit(100),
    supabase.from("property_rejection_reasons").select("client_id,request_id,phase,note,is_primary,created_at,reason:rejection_reasons(code,label_ar,category)").eq("property_id", propertyId).order("created_at", { ascending: false }).limit(100),
    supabase.from("property_marketing_events").select("channel,event_type,published_at,views,reach,likes,comments,shares,saves,total_interactions,plays,notes,url,created_at").eq("property_id", propertyId).order("created_at", { ascending: false }).limit(50),
    supabase.from("crm_deals_access").select("id,client_id,request_id,stage,deal_value,closing_probability,created_at,closed_at").eq("property_id", propertyId).order("created_at", { ascending: false }).limit(50),
  ]);

  if (propertyR.error) return json({ ok: false, error: propertyR.error.message }, propertyR.error.code === "PGRST116" ? 404 : 400);
  const property = propertyR.data;
  const evidenceReads = { inquiries: inquiriesR, viewings: viewingsR, rejections: rejectionsR, marketing: marketingR, deals: dealsR };
  const failedSources = Object.entries(evidenceReads).filter(([, result]) => result.error).map(([name]) => name);
  if (failedSources.length) {
    console.error("[property-ai-insights] evidence unavailable", failedSources);
    return json({ ok: false, error: "evidence_load_failed", failed_sources: failedSources,
      message: "تعذر تحميل بعض بيانات العقار ولم يتم إنشاء تحليل ناقص. حاول مرة أخرى بعد اكتمال الاتصال.", saved: false }, 503);
  }
  const allRelations = inquiriesR.data || [];
  const inquiries = allRelations.filter((x:any) => x.has_inbound_inquiry !== false);
  const viewings = viewingsR.data || [];
  const rejections = rejectionsR.data || [];
  const marketing = marketingR.data || [];
  const deals = dealsR.data || [];

  const uniqueInquirers = new Set(inquiries.map((x:any) => x.client_id).filter(Boolean)).size;
  const inquiryEvents = inquiries.reduce((n:number,x:any) => n + Number(x.inquiry_count || 1), 0);
  const completedViewings = viewings.filter((x:any) => x.status === "done").length;
  const uniqueVisitors = new Set(viewings.filter((x:any) => x.status === "done").map((x:any) => x.client_id).filter(Boolean)).size;
  const lastInquiryAt = latestIso(inquiries.map((x:any) => x.last_inquiry_at));
  const lastMarketingAt = latestIso(marketing.map((x:any) => x.published_at || x.created_at));
  const trackingAnchor = latestIso([lastInquiryAt, property.performance_tracking_started_at, lastMarketingAt, property.created_at]);
  const daysWithoutInquiry = trackingAnchor ? Math.max(0, Math.floor((Date.now() - new Date(trackingAnchor).getTime()) / 86400000)) : 0;

  const reasonCounts = new Map<string,{code:string;label:string;category:string;clients:Set<string>;notes:string[]}>();
  for (const r of rejections as any[]) {
    const reason:any = Array.isArray(r.reason) ? r.reason[0] : r.reason;
    const code = reason?.code || "unknown";
    const item = reasonCounts.get(code) || { code, label: reason?.label_ar || code, category: reason?.category || "other", clients:new Set<string>(), notes:[] };
    if (r.client_id) item.clients.add(r.client_id);
    if (r.note) item.notes.push(String(r.note));
    reasonCounts.set(code,item);
  }
  const structuredReasons = [...reasonCounts.values()].map(x => ({code:x.code,label:x.label,category:x.category,unique_clients:x.clients.size,notes:x.notes.slice(0,10)})).sort((a,b)=>b.unique_clients-a.unique_clients);

  const context = {
    property,
    tracking: {
      tracking_started_at: property.performance_tracking_started_at,
      last_inbound_inquiry_at: lastInquiryAt,
      last_marketing_at: lastMarketingAt,
      tracking_anchor: trackingAnchor,
      days_without_inquiry: daysWithoutInquiry,
      rule_threshold_days: 5
    },
    metrics: {
      unique_inquirers: uniqueInquirers,
      inquiry_events: inquiryEvents,
      completed_viewings: completedViewings,
      unique_visitors: uniqueVisitors,
      rejected_clients: new Set(rejections.map((x:any)=>x.client_id).filter(Boolean)).size,
      days_without_inquiry: daysWithoutInquiry,
      negotiations: deals.filter((x:any)=>["negotiation","negotiating"].includes(x.stage)).length,
      closed_deals: deals.filter((x:any)=>["closed","commission_collected"].includes(x.stage)).length,
    },
    structured_rejection_reasons: structuredReasons.slice(0,12),
    inquiry_feedback: inquiries.slice(0,30).map((x:any)=>({status:x.status,rejection_reason:x.rejection_reason,rejection_notes:x.rejection_notes,last_message:x.last_message,match_notes:x.match_notes,client_response:x.client_response,post_visit_interest:x.post_visit_interest,outcome:x.outcome})),
    viewing_feedback: viewings.slice(0,30).map((x:any)=>({status:x.status,attendance:x.attendance,client_feedback:x.client_feedback,rejection_reason:x.rejection_reason,liked:x.liked,next_step:x.next_step,notes:x.notes})),
    marketing: marketing.slice(0,15),
    deals: deals.slice(0,15),
  };

  const instructions = `You are a real-estate sales performance analyst for Maskaan_0 in Oman. Analyze ONE property using only the supplied CRM evidence. Return Arabic text suitable for a manager.

Critical timing rule:
- TRUST tracking.days_without_inquiry. It is already calculated from the latest of: CRM performance tracking start, latest inbound inquiry, and latest marketing/relaunch event. NEVER calculate inactivity from the property's original created_at when a newer tracking anchor exists.
- If days_without_inquiry is below 5 and there is no repeated obstacle from at least 2 distinct clients, do not label the property urgent merely because it is old. Say it is under monitoring and that the 5-day evaluation window has not completed.

Other rules:
- Never invent market prices, renovation details, customer opinions, view counts, reach, engagement, or competitor data.
- A null Instagram metric means the metric has not been synced/entered; it does NOT mean zero.
- Repeated obstacle requires evidence from at least 2 distinct clients where available.
- Distinguish lack of inquiries from poor post-viewing conversion.
- At 5+ tracked days with no inquiries, recommend a rapid pre-reshoot review: price positioning, cover/title/description/audience, then new photography or refreshed creative and relaunch.
- Do NOT automatically recommend lowering price. Recommend a price reduction only when repeated CRM evidence points to price/value mismatch.
- For finishings, name the exact issue only when notes contain it. Otherwise say the complaint is too general and staff should capture the exact element.
- Keep recommendations operational and prioritized. Include what to discuss with the owner.
- Do not claim Instagram performance is poor if views/reach/engagement are null; state that performance metrics are not yet available.`;

  let response: Response;
  try { response = await fetch("https://api.openai.com/v1/responses", {
    method:"POST",
    headers:{"Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      model:OPENAI_MODEL, store:false, reasoning:{effort:"low"}, instructions,
      input:JSON.stringify(context),
      text:{format:{type:"json_schema",name:"property_sales_insight",strict:true,schema:insightSchema}}
    })
  });
  } catch (_error) {
    return json({ok:false,error:"ai_connection_failed",saved:false,message:"تعذر الاتصال بخدمة التحليل ولم يتم حفظ نتيجة."},503);
  }
  const payload = await response.json().catch(()=>null);
  if (!payload) return json({ok:false,error:"invalid_ai_response",saved:false},502);
  if (!response.ok) return json({ok:false,error:payload?.error?.message || `OpenAI ${response.status}`},502);
  const outputText = payload?.output_text || payload?.output?.flatMap((x:any)=>x?.content||[]).find((x:any)=>x?.type==="output_text")?.text;
  if (!outputText) return json({ok:false,error:"no_ai_output"},502);
  let insight:any;
  try { insight=JSON.parse(outputText); } catch { return json({ok:false,error:"invalid_ai_output"},502); }

  const repeated = structuredReasons[0]?.unique_clients >= 2;
  const alertType = daysWithoutInquiry >= 5 ? "no_inquiry_5d" : (repeated ? "repeated_obstacle" : "manual_ai_review");
  const now = new Date().toISOString();
  const propertySave = await supabase.from("properties")
    .update({last_ai_recommendation:insight,last_ai_recommendation_at:now})
    .eq("id",propertyId).select("id").maybeSingle();
  if (propertySave.error || !propertySave.data) {
    return json({ ok:false, error:"recommendation_save_failed", saved:false, insight,
      message:"اكتمل التحليل لكن تعذر حفظه في العقار. لم يتم تسجيل نجاح الحفظ." }, 503);
  }
  const reviewSave = await supabase.from("property_action_reviews").insert({
    company_id:property.company_id, property_id:propertyId, alert_type:alertType,
    trigger_reason:insight.diagnosis, severity:insight.priority==="low"?"info":insight.priority,
    status:"in_review", ai_recommendation:insight, created_by:userData.user.id
  }).select("id").single();
  if (reviewSave.error || !reviewSave.data) {
    return json({ ok:false, error:"review_save_failed", saved:true, review_saved:false, insight,
      message:"تم حفظ التحليل في العقار لكن تعذر تسجيل إجراء المراجعة. لا تعِد التحليل تلقائياً." }, 503);
  }

  return json({ok:true,saved:true,review_saved:true,insight,context_summary:context.metrics,tracking:context.tracking});
});

