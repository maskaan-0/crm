(function(){
  var wrapped=false;
  var clickBound=false;
  var routingWrapped=false;
  var investmentBinding=false;
  function label(k){return k==='barka'?'بركاء':k==='investment'?'المشاريع الاستثمارية':'مسقط'}
  function toast(msg,type){try{if(typeof showToast==='function')showToast(msg,type||'info')}catch(_e){}}

  async function bindInvestmentWithSavedAuthorization(){
    if(investmentBinding)return;
    if(typeof isOwner!=='function'||!isOwner()){toast('فقط صاحب الشركة يمكنه ربط أرقام واتساب','error');return;}
    var row=typeof leadRouteData!=='undefined'?leadRouteData.investment:null;
    var input=document.getElementById('routePhone_investment');
    var digits=function(v){return String(v||'').replace(/\D/g,'')};
    if(!row||!digits(row.whatsapp_number)){toast('احفظ رقم المستثمر في توزيع العملاء أولاً','error');return;}
    if(input&&digits(input.value)!==digits(row.whatsapp_number)){toast('احفظ تعديل رقم المستثمر قبل الربط','error');return;}
    investmentBinding=true;
    var btn=document.getElementById('investmentSavedMetaBind');
    if(btn)btn.disabled=true;
    toast('جاري التحقق من رقم المستثمر باستخدام تفويض الشركة المحفوظ...','info');
    try{
      var r=await supa.functions.invoke('whatsapp-direct-bind',{body:{route_key:'investment'}});
      var d=r.data||{};
      if(r.error){
        if(r.error.context&&typeof r.error.context.json==='function'){
          try{d=await r.error.context.json()}catch(_e){}
        }
        throw new Error(d.message||d.error||r.error.message||'bind_failed');
      }
      if(!d.ok)throw new Error(d.message||d.error||'bind_failed');
      toast('تم حفظ ربط رقم المستثمر بالـCRM. اختبر وصول رسالة من رقم آخر.','success');
      if(typeof loadLeadRouting==='function')await loadLeadRouting();
    }catch(e){
      var m=String(e&&e.message||e);
      if(m.indexOf('ROUTE_PHONE_NOT_FOUND_IN_BUSINESS_ASSETS')>=0){
        toast('اكتمل الفحص: رقم المستثمر غير ظاهر في أي حساب واتساب تملكه الشركة في Meta. يلزم إكمال إعداد الرقم عبر Meta أو تحرير ملكيته القديمة أولاً.','error');
      }else if(m.indexOf('SYSTEM_USER_NOT_ASSIGNED_TO_WABA')>=0){
        toast('الرقم ظاهر في Meta، لكن مستخدم النظام غير مسند إلى حساب واتساب الخاص به.','error');
      }else if(m.indexOf('invalid_auth')>=0||m.indexOf('missing_auth')>=0){
        toast('انتهت جلسة CRM. سجّل الدخول بحساب صاحب الشركة ثم أعد الربط.','error');
      }else{
        toast('تعذر إكمال ربط المستثمر. بقي الربط غير مؤكد؛ أرسل صورة الرسالة لمراجعة سجل المحاولة.','error');
      }
    }finally{
      investmentBinding=false;
      var current=document.getElementById('investmentSavedMetaBind');
      if(current)current.disabled=false;
    }
  }

  function addInvestmentBindButton(){
    if(document.getElementById('investmentSavedMetaBind'))return;
    var input=document.getElementById('routePhone_investment');
    var grid=input&&input.closest('.fgrid');
    var card=grid&&grid.parentElement;
    var existing=card&&card.querySelector('button[onclick*="launchWhatsAppEmbeddedSignup"]');
    if(!existing)return;
    var btn=document.createElement('button');
    btn.id='investmentSavedMetaBind';btn.type='button';btn.className='btn-secondary';
    btn.style.cssText='width:auto;padding:8px 14px';
    btn.textContent='🔎 فحص ظهور رقم المستثمر في Meta';
    btn.disabled=investmentBinding;
    btn.addEventListener('click',bindInvestmentWithSavedAuthorization);
    existing.parentElement.insertBefore(btn,existing);
    existing.textContent='إعداد واتساب الهاتف عبر Meta';
  }

  function wrapRouting(){
    if(routingWrapped||typeof window.loadLeadRouting!=='function')return;
    var old=window.loadLeadRouting;
    window.loadLeadRouting=async function(){var result=await old.apply(this,arguments);addInvestmentBindButton();return result;};
    routingWrapped=true;
  }

  async function directBind(routeKey){
    if(routeKey!=='muscat'&&routeKey!=='barka')return false;
    if(typeof isOwner==='function'&&!isOwner()){toast('فقط صاحب الشركة يمكنه ربط أرقام واتساب','error');return true;}
    if(typeof FB==='undefined'||!FB.login){toast('Meta لم يكتمل تحميله بعد. حدّث الصفحة وحاول مرة أخرى.','error');return true;}
    var name=label(routeKey);
    toast('جاري فتح تفويض Meta لرقم '+name+'...','info');
    try{
      FB.login(async function(response){
        try{
          var auth=response&&response.authResponse;
          if(!auth||!auth.accessToken)throw new Error('لم يرجع Meta صلاحية الوصول');
          toast('تم التفويض. جاري التحقق من رقم '+name+' وربطه...','info');
          var r=await supa.functions.invoke('whatsapp-direct-bind',{body:{route_key:routeKey,user_access_token:auth.accessToken}});
          if(r.error)throw r.error;
          var d=r.data||{};
          if(!d.ok)throw new Error(d.message||d.error||'فشل الربط');
          toast('تم ربط رقم '+name+' مع Meta والـCRM بنجاح','success');
          if(typeof loadLeadRouting==='function')await loadLeadRouting();
        }catch(e){
          var m=String(e&&e.message||e);
          if(m.indexOf('ROUTE_PHONE_NOT_FOUND_IN_BUSINESS_ASSETS')>=0)toast('رقم '+name+' غير ظاهر بعد ضمن أصول واتساب في Meta. لا تعيد المحاولة الآن.','error');
          else toast('تعذر ربط '+name+': '+m,'error');
        }
      },{scope:'business_management,whatsapp_business_management,whatsapp_business_messaging',return_scopes:true,auth_type:'rerequest'});
    }catch(e){toast('تعذر فتح Meta: '+String(e&&e.message||e),'error');}
    return true;
  }

  function nearestRouteForButton(btn){
    var keys=['muscat','barka','investment'];
    var best=null,bestScore=1e9;
    keys.forEach(function(k){
      var input=document.getElementById('routePhone_'+k);if(!input)return;
      var bAnc=[],n=btn;while(n&&bAnc.length<14){bAnc.push(n);n=n.parentElement;}
      n=input;var d=0;while(n&&d<14){var bi=bAnc.indexOf(n);if(bi>=0){var score=bi+d;if(score<bestScore){bestScore=score;best=k;}break;}n=n.parentElement;d++;}
    });
    return best;
  }

  function bindCaptureClick(){
    if(clickBound)return;
    document.addEventListener('click',function(ev){
      var btn=ev.target&&ev.target.closest?ev.target.closest('button'):null;
      if(!btn)return;
      var txt=String(btn.textContent||'').replace(/\s+/g,' ').trim();
      if(txt.indexOf('Meta')<0)return;
      var routeKey=nearestRouteForButton(btn);
      if(routeKey!=='barka')return;
      ev.preventDefault();ev.stopPropagation();if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();
      directBind('barka');
    },true);
    clickBound=true;
  }

  function wrapLegacy(){
    if(wrapped)return;
    var oldLaunch=window.launchWhatsAppEmbeddedSignup;
    if(typeof oldLaunch!=='function')return;
    window.launchWhatsAppEmbeddedSignup=function(routeKey){
      if(routeKey==='muscat'||routeKey==='barka')return directBind(routeKey);
      return oldLaunch.apply(this,arguments);
    };
    wrapped=true;
  }

  function install(){bindCaptureClick();wrapLegacy();wrapRouting();addInvestmentBindButton();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
  window.addEventListener('load',install);
  setTimeout(install,300);setTimeout(install,900);setTimeout(install,1800);setTimeout(install,3500);setTimeout(install,6500);
  window.Maskaan-0DirectMetaBind=directBind;
})();
