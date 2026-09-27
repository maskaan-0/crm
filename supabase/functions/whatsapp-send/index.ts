import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")??"";
const SUPABASE_ANON_KEY=Deno.env.get("SUPABASE_ANON_KEY")??"";
const SUPABASE_SERVICE_ROLE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"";
const CRM_COMPANY_ID=Deno.env.get("CRM_COMPANY_ID")??"";
const WHATSAPP_ACCESS_TOKEN=Deno.env.get("WHATSAPP_ACCESS_TOKEN")??"";
const META_APP_SECRET=Deno.env.get("META_APP_SECRET")??"";
const META_GRAPH_VERSION=Deno.env.get("META_GRAPH_VERSION")||"v25.0";
const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
function json(data:unknown,status=200){if(data&&typeof data==="object"&&(data as any).ok===false)data={sent:false,retry_safe:true,...data};return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,"content-type":"application/json; charset=utf-8"}})}
function cleanDigits(value:unknown){return String(value??"").replace(/\D/g,"")}
function shortText(value:unknown,max=4000){const s=String(value??"").trim();return s.length>max?`${s.slice(0,max)}…`:s}
function b64ToBytes(s:string){const bin=atob(s);const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
async function decryptToken(ciphertext:string,ivB64:string,companyId:string,routeKey:string){const seed=new TextEncoder().encode(`${META_APP_SECRET}|${companyId}|${routeKey}|maskaan0-crm-whatsapp-v1`);const digest=await crypto.subtle.digest("SHA-256",seed);const key=await crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["decrypt"]);const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64ToBytes(ivB64)},key,b64ToBytes(ciphertext));return new TextDecoder().decode(plain)}
async function metaSend(token:string,phoneId:string,to:string,messageBody:string){const r=await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}/messages`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{preview_url:false,body:messageBody}})});const p=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,data:p}}

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
 if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
 if(!SUPABASE_URL||!SUPABASE_ANON_KEY||!SUPABASE_SERVICE_ROLE_KEY||!META_APP_SECRET)return json({ok:false,error:"server_not_configured"},503);
 let acceptedSend:any=null,operationClaimed=false;
 const authHeader=req.headers.get("authorization")||"";if(!authHeader.toLowerCase().startsWith("bearer "))return json({ok:false,error:"missing_auth"},401);
 try{
  const userClient=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false,autoRefreshToken:false}});
  const admin=createClient(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData,error:userError}=await userClient.auth.getUser();const user=userData?.user;if(userError||!user)return json({ok:false,error:"invalid_auth"},401);
  const {data:profile,error:profileError}=await admin.from("profiles").select("id,company_id,role,is_active,full_name").eq("id",user.id).single();
  if(profileError||!profile||profile.is_active===false)return json({ok:false,error:"profile_not_authorized"},403);
  if(CRM_COMPANY_ID&&profile.company_id!==CRM_COMPANY_ID)return json({ok:false,error:"wrong_company"},403);
  if(!["owner","manager","agent"].includes(String(profile.role)))return json({ok:false,error:"whatsapp_send_not_allowed"},403);

  const body=await req.json().catch(()=>null);const clientId=String(body?.client_id||"").trim();const requestedConversationId=String(body?.conversation_id||"").trim();const requestedRequestId=String(body?.request_id||"").trim();const messageBody=shortText(body?.body,4000);const operationId=String(body?.operation_id||"").trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))return json({ok:false,error:"operation_id_required",message:"حدّث صفحة النظام ثم أعد المحاولة قبل الإرسال."},400);
  if(!clientId)return json({ok:false,error:"client_id_required"},400);if(!messageBody)return json({ok:false,error:"message_required"},400);
  const {data:client,error:clientError}=await admin.from("clients").select("id,company_id,name,phone,assigned_to").eq("id",clientId).eq("company_id",profile.company_id).single();
  if(clientError||!client)return json({ok:false,error:"client_not_found"},404);
  const to=cleanDigits(client.phone);if(!to||to.length<7||to.length>15)return json({ok:false,error:"invalid_client_phone"},400);

  async function requestTeamAllowed(requestId:string){
    if(profile.role!=="agent")return true;
    const a=await admin.from("client_request_assignees").select("request_id").eq("company_id",profile.company_id).eq("request_id",requestId).eq("user_id",user.id).maybeSingle();
    if(a.error)throw new Error(`request_team_lookup_failed: ${a.error.message}`);
    return Boolean(a.data?.request_id);
  }

  let resolvedRequest:any=null,requestLinkState="none";
  if(requestedRequestId){
    const rr=await admin.from("client_requests").select("id,assigned_to,route_key,branch_key,status,updated_at").eq("id",requestedRequestId).eq("company_id",profile.company_id).eq("client_id",clientId).maybeSingle();
    if(rr.error)return json({ok:false,error:`request_lookup_failed: ${rr.error.message}`},500);if(!rr.data)return json({ok:false,error:"request_not_found"},404);
    if(profile.role==="agent"&&rr.data.assigned_to!==user.id&&!(await requestTeamAllowed(rr.data.id)))return json({ok:false,error:"request_not_authorized"},403);
    resolvedRequest=rr.data;requestLinkState="explicit";
  } else {
    let q=admin.from("client_requests").select("id,route_key,branch_key,status,updated_at,assigned_to").eq("company_id",profile.company_id).eq("client_id",clientId).in("status",["active","paused"]);
    const rq=await q.order("updated_at",{ascending:false}).limit(20);if(rq.error)return json({ok:false,error:`request_lookup_failed: ${rq.error.message}`},500);
    let rows=rq.data||[];
    if(profile.role==="agent"){
      const a=await admin.from("client_request_assignees").select("request_id").eq("company_id",profile.company_id).eq("user_id",user.id).in("request_id",rows.map((x:any)=>x.id));
      if(a.error)throw new Error(`request_team_filter_failed: ${a.error.message}`);const allowed=new Set((a.data||[]).map((x:any)=>String(x.request_id)));
      rows=rows.filter((x:any)=>x.assigned_to===user.id||allowed.has(String(x.id)));
    }
    if(rows.length===1){resolvedRequest=rows[0];requestLinkState="unique_active_request";}else if(rows.length>1)requestLinkState="ambiguous_multiple_requests";
  }

  let desiredRouteKey=String(resolvedRequest?.branch_key||resolvedRequest?.route_key||"");
  if(!["muscat","barka","investment"].includes(desiredRouteKey))desiredRouteKey="";

  const convSelect="id,client_id,route_key,assigned_to,meta_phone_number_id,last_inbound_at,last_message_at,unread_count";
  let conversation:any=null;
  if(desiredRouteKey){
    const {data:routeRow,error:routeErr}=await admin.from("company_lead_routes").select("route_key,meta_phone_number_id,whatsapp_number,owner_only_inbox,assigned_to,is_active").eq("company_id",profile.company_id).eq("route_key",desiredRouteKey).eq("is_active",true).maybeSingle();
    if(routeErr)return json({ok:false,error:`desired_route_lookup_failed: ${routeErr.message}`},500);
    if(routeRow?.meta_phone_number_id){
      const r=await admin.from("whatsapp_conversations").select(convSelect).eq("company_id",profile.company_id).eq("client_id",clientId).eq("meta_phone_number_id",String(routeRow.meta_phone_number_id)).not("last_inbound_at","is",null).order("last_inbound_at",{ascending:false}).limit(1).maybeSingle();
      if(r.error)return json({ok:false,error:`route_conversation_lookup_failed: ${r.error.message}`},500);conversation=r.data||null;
    }
    if(!conversation && requestedConversationId){
      const r=await admin.from("whatsapp_conversations").select(convSelect).eq("id",requestedConversationId).eq("company_id",profile.company_id).eq("client_id",clientId).maybeSingle();
      if(r.error)return json({ok:false,error:`conversation_lookup_failed: ${r.error.message}`},500);
      if(r.data && String(r.data.route_key||"")===desiredRouteKey)conversation=r.data;
    }
    if(!conversation){
      return json({ok:false,error:"route_handoff_required",desired_route:desiredRouteKey,message:`هذا الطلب تابع لمسار ${desiredRouteKey==='barka'?'بركاء':desiredRouteKey==='muscat'?'مسقط':'المشاريع الاستثمارية'}، لكن لا توجد محادثة واردة مفتوحة على رقم هذا المسار. تابع العميل من WhatsApp Business الخاص بالمسار الصحيح يدوياً، أو انتظر حتى يرسل على ذلك الرقم.`},409);
    }
  } else if(requestedConversationId){
    const r=await admin.from("whatsapp_conversations").select(convSelect).eq("id",requestedConversationId).eq("company_id",profile.company_id).eq("client_id",clientId).maybeSingle();if(r.error)return json({ok:false,error:`conversation_lookup_failed: ${r.error.message}`},500);conversation=r.data;
  } else {
    const r=await admin.from("whatsapp_conversations").select(convSelect).eq("company_id",profile.company_id).eq("client_id",clientId).not("last_inbound_at","is",null).order("last_inbound_at",{ascending:false}).limit(1).maybeSingle();if(r.error)return json({ok:false,error:`conversation_lookup_failed: ${r.error.message}`},500);conversation=r.data;
  }
  if(!conversation)return json({ok:false,error:"no_whatsapp_conversation",message:"لا توجد محادثة واتساب واردة لهذا العميل حتى نحدد رقم الإرسال الصحيح."},409);

  const senderPhoneNumberId=cleanDigits(conversation.meta_phone_number_id);if(!senderPhoneNumberId)return json({ok:false,error:"conversation_sender_missing",message:"المحادثة لا تحتوي على Meta Phone Number ID صالح."},409);
  const {data:routeData,error:routeError}=await admin.rpc("resolve_whatsapp_route",{p_company_id:profile.company_id,p_meta_phone_number_id:senderPhoneNumberId});if(routeError)return json({ok:false,error:`sender_route_lookup_failed: ${routeError.message}`},500);
  const routeRow=Array.isArray(routeData)?routeData[0]:routeData;if(!routeRow?.whatsapp_number)return json({ok:false,error:"sender_not_configured",message:"رقم واتساب الخاص بهذه المحادثة غير مربوط بمسار نشط."},409);
  const routeKey=String(routeRow?.route_key||conversation.route_key||"").trim();
  const {data:routePolicy,error:routePolicyError}=await admin.from("company_lead_routes").select("route_key,owner_only_inbox,assigned_to,is_active").eq("company_id",profile.company_id).eq("route_key",routeKey).maybeSingle();if(routePolicyError)return json({ok:false,error:`route_policy_lookup_failed: ${routePolicyError.message}`},500);
  const ownerOnly=routePolicy?.owner_only_inbox===true;
  let allowed=profile.role==="owner" || (profile.role==="manager"&&!ownerOnly);
  if(profile.role==="agent"&&!ownerOnly){allowed=conversation.assigned_to===user.id||client.assigned_to===user.id||Boolean(resolvedRequest&&await requestTeamAllowed(resolvedRequest.id));}
  if(!allowed)return json({ok:false,error:"conversation_not_authorized"},403);

  const lastInboundMs=conversation.last_inbound_at?new Date(conversation.last_inbound_at).getTime():0;const within24h=lastInboundMs>0&&(Date.now()-lastInboundMs)<24*60*60*1000;
  if(!within24h)return json({ok:false,error:"outside_customer_service_window",message:"آخر رسالة واردة من العميل على رقم هذا المسار أقدم من 24 ساعة. تابع العميل من WhatsApp Business يدوياً، أو استخدم Template معتمد إذا فُعّل لاحقاً."},409);

  const resolvedRequestId=resolvedRequest?.id||null;
  let routeToken:string|null=null;let routeCredentialType:string|null=null;
  try{const cr=await admin.from("whatsapp_route_credentials").select("token_ciphertext,token_iv,token_type,expires_at").eq("company_id",profile.company_id).eq("route_key",routeKey).maybeSingle();if(!cr.error&&cr.data){const exp=cr.data.expires_at?new Date(cr.data.expires_at).getTime():0;if(!exp||exp>Date.now()+60000){routeToken=await decryptToken(cr.data.token_ciphertext,cr.data.token_iv,String(profile.company_id),routeKey);routeCredentialType=cr.data.token_type||"route";}}}catch(e){console.error("[whatsapp-send] route credential decrypt",String((e as any)?.message||e));}
  const candidates:Array<{token:string,source:string}>=[];if(routeToken)candidates.push({token:routeToken,source:`route_${routeCredentialType||'credential'}`});if(WHATSAPP_ACCESS_TOKEN&&WHATSAPP_ACCESS_TOKEN!==routeToken)candidates.push({token:WHATSAPP_ACCESS_TOKEN,source:"server_system_user"});if(!candidates.length)return json({ok:false,error:"no_send_credential",message:"لا يوجد رمز Meta صالح للإرسال لهذا المسار."},409);
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({clientId,conversationId:conversation.id,requestId:resolvedRequestId,messageBody,senderPhoneNumberId})))))
    .map(x=>x.toString(16).padStart(2,"0")).join("");
  const operationFilter={company_id:profile.company_id,user_id:user.id,operation_key:operationId};
  const claim=await admin.from("whatsapp_send_operations").insert({...operationFilter,client_id:clientId,conversation_id:conversation.id,crm_request_id:resolvedRequestId,payload_hash:fingerprint,status:"processing"});
  if(claim.error){
    if(claim.error.code!=="23505")return json({ok:false,error:"send_journal_unavailable",sent:false,retry_safe:true,message:"تعذر تأمين سجل الإرسال ولم تُرسل الرسالة."},503);
    const existing=await admin.from("whatsapp_send_operations").select("payload_hash,status,result")
      .eq("company_id",profile.company_id).eq("user_id",user.id).eq("operation_key",operationId).maybeSingle();
    if(existing.error||!existing.data)return json({ok:false,error:"send_status_unknown",sent:null,retry_safe:false,message:"تعذر التحقق من محاولة الإرسال السابقة. تحقق من المحادثة قبل محاولة جديدة."});
    if(existing.data.payload_hash!==fingerprint)return json({ok:false,error:"operation_conflict",sent:false,retry_safe:false,message:"معرّف المحاولة مرتبط برسالة مختلفة."},409);
    if(existing.data.status==="failed"&&existing.data.result?.retry_safe===true){
      // A definite provider rejection is safe to retry, but only one caller may reclaim it.
      const reclaimed=await admin.from("whatsapp_send_operations").update({status:"processing",result:null,updated_at:new Date().toISOString()})
        .eq("company_id",profile.company_id).eq("user_id",user.id).eq("operation_key",operationId).eq("status","failed").select("operation_key").maybeSingle();
      if(reclaimed.error||!reclaimed.data)return json({ok:false,error:"send_in_progress",sent:null,retry_safe:false,message:"يجري التحقق من محاولة الإرسال. لم نكرر الرسالة."});
    }else{
      if(existing.data.result)return json({...existing.data.result,replayed:true});
      return json({ok:false,error:"send_in_progress",sent:null,retry_safe:false,message:"محاولة الإرسال قيد المعالجة. لم نكرر إرسال الرسالة."});
    }
  }
  operationClaimed=true;
  async function finishOperation(status:string,result:any){
    const r=await admin.from("whatsapp_send_operations").update({status,result,updated_at:new Date().toISOString()})
      .eq("company_id",profile.company_id).eq("user_id",user.id).eq("operation_key",operationId);
    if(r.error)console.error("[whatsapp-send] operation save failed",r.error.code||"database_error");
    return !r.error;
  }
  let graphRes:any=null,sendSource="";const errors:any[]=[];
  for(const c of candidates){
    let r:any;
    try{r=await metaSend(c.token,senderPhoneNumberId,to,messageBody);}
    catch(_error){
      const result={ok:false,error:"send_status_unknown",sent:null,recorded:false,retry_safe:false,operation_id:operationId,message:"انقطع الاتصال أثناء الإرسال وقد تكون الرسالة وصلت. تحقق من المحادثة ولا تعِد الإرسال تلقائياً."};
      await finishOperation("unknown",result);return json(result);
    }
    if(r.ok){graphRes=r;sendSource=c.source;break;}
    errors.push({source:c.source,status:r.status,code:r.data?.error?.code||null,subcode:r.data?.error?.error_subcode||null,message:r.data?.error?.error_user_msg||r.data?.error?.message||`Meta HTTP ${r.status}`});
    // Only a definite credentials rejection is safe to try with another credential.
    if(![190,10,200].includes(Number(r.data?.error?.code)))break;
  }
  if(!graphRes){
    const last=errors[errors.length-1]||{};
    const uncertain=Number(last.status)>=500 || Number(last.status)===408;
    const result={ok:false,error:uncertain?"send_status_unknown":"meta_send_failed",sent:uncertain?null:false,recorded:false,retry_safe:!uncertain,operation_id:operationId,message:uncertain?"حالة الإرسال غير مؤكدة. تحقق من المحادثة قبل أي محاولة جديدة.":last.message||"تعذر إرسال الرسالة",attempts:errors};
    await finishOperation(uncertain?"unknown":"failed",result);return json(result);
  }
  const graphPayload=graphRes.data;const wamid=graphPayload?.messages?.[0]?.id;const now=new Date().toISOString();
  if(!wamid){
    const unknown={ok:false,error:"send_status_unknown",sent:null,recorded:false,retry_safe:false,operation_id:operationId,message:"لم يُرجع مزود واتساب معرّف الرسالة. تحقق من المحادثة ولا تعِد إرسالها تلقائياً."};
    await finishOperation("unknown",unknown);return json(unknown);
  }
  const responseBase={ok:true,sent:true,recorded:true,retry_safe:false,operation_id:operationId,message_id:wamid||null,to,sent_at:now,conversation_id:conversation.id,request_id:resolvedRequestId,request_link_state:requestLinkState,sender_phone_number_id:senderPhoneNumberId,route_key:routeKey,sender_whatsapp_number:routeRow?.whatsapp_number||null,credential_source:sendSource};
  acceptedSend=responseBase;
  const failures:string[]=[];
  if(wamid){
    const ins=await admin.from("whatsapp_messages").insert({company_id:profile.company_id,conversation_id:conversation.id,client_id:clientId,request_id:resolvedRequestId,sent_by_user_id:user.id,actor_type:"human",channel_source:"crm",whatsapp_message_id:wamid,direction:"outbound",message_type:"text",sender_wa_id:senderPhoneNumberId,recipient_wa_id:to,body:messageBody,message_timestamp:now,delivery_status:"sent",raw_payload:{source:"crm_direct_send_idempotent",credential_source:sendSource,sent_by:user.id,request_link_state:requestLinkState,request_id:resolvedRequestId,route_key:routeKey,sender_phone_number_id:senderPhoneNumberId,operation_id:operationId,graph_response:graphPayload}});
    if(ins.error&&ins.error.code!=="23505")failures.push("message_history");
  }else failures.push("provider_message_id");
  // Conversation timestamps are maintained atomically by the message-insert trigger.
  const clientUpdate=await admin.from("clients").update({last_contact_at:now}).eq("id",clientId).eq("company_id",profile.company_id);
  if(clientUpdate.error)failures.push("client_contact_time");
  const activity=await admin.from("activities").insert({company_id:profile.company_id,user_id:user.id,client_id:clientId,request_id:resolvedRequestId,type:"whatsapp",description:`رسالة واتساب مرسلة من CRM عبر ${routeKey||"whatsapp"}: ${shortText(messageBody,900)}`,activity_type:"whatsapp",activity_text:`رسالة واتساب مرسلة من CRM عبر ${routeKey||"whatsapp"}: ${shortText(messageBody,900)}`,channel:"whatsapp",direction:"outbound",actor_type:"human",occurred_at:now,outcome:"sent",after_data:{conversation_id:conversation.id,whatsapp_message_id:wamid||null,request_link_state:requestLinkState,credential_source:sendSource,operation_id:operationId}});
  if(activity.error)failures.push("activity_history");
  const result={...responseBase,recorded:failures.length===0,recording_failures:failures,
    ...(failures.length?{warning:"sent_but_not_recorded",message:"أُرسلت الرسالة بنجاح لكن لم يكتمل حفظ سجلها في النظام. لا تعِد إرسالها."}:{})};
  const journalSaved=await finishOperation("sent",result);
  if(!journalSaved){result.recorded=false;result.recording_failures.push("operation_journal");Object.assign(result,{warning:"sent_but_not_recorded",message:"أُرسلت الرسالة لكن لم يكتمل تسجيل المحاولة. لا تعِد إرسالها."});}
  return json(result);
 }catch(err){console.error("[whatsapp-send]",String((err as any)?.message||err));if(acceptedSend)return json({...acceptedSend,recorded:false,warning:"sent_but_not_recorded",message:"أُرسلت الرسالة لكن تعذر إكمال سجلها. لا تعِد إرسالها."});if(operationClaimed)return json({ok:false,error:"send_status_unknown",sent:null,recorded:false,retry_safe:false,message:"تعذر تأكيد حالة المحاولة. تحقق من المحادثة قبل أي إرسال جديد."});return json({ok:false,error:"internal_error",message:String((err as any)?.message||err).slice(0,1000)},500)}
});
