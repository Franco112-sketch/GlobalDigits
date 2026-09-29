/* ══════════════════════════════════════════════════════════════════
   REFER & EARN — standalone module, isolated from the main app script.
   Loaded after the main script (so it can use the globals it already
   sets up: sb, currentUser, toast, nav, copyText, openMoreSheet)
   but owns all of its own state, rendering and DB calls. Never reads or
   writes profiles.balance / profiles.balance_usd / profiles.points_balance
   — only profiles.referral_balance, referrals, and referral_rewards.
   ══════════════════════════════════════════════════════════════════ */

/* ── Referral-code capture ──
   Runs on every page load (see the one-line hook added near the bottom
   of index.html's own init block). Stores a ?ref=CODE URL param the same
   way the existing welcome-coupon handoff already works (localStorage,
   read once, cleared after use) so it survives the redirect through
   email-confirmation.html and back. */
function captureReferralCodeFromUrl(){
  try{
    var qp=new URLSearchParams(window.location.search);
    var code=qp.get('ref');
    if(code&&code.trim())localStorage.setItem('gd_pending_ref_code',code.trim().toUpperCase());
    // Pre-fill the registration form's referral-code field (if present in
    // the DOM) so a user arriving via a referral link sees it was already
    // applied, and can still edit/clear it before creating their account.
    var pending=localStorage.getItem('gd_pending_ref_code');
    var input=document.getElementById('regRefCode');
    if(pending&&input&&!input.value)input.value=pending;
  }catch(e){}
}
// Called from launchApp() once a real session exists — the one place
// that's true whether this is a fresh signup or a later login after
// email confirmation. Safe to call every time: the DB's own unique
// constraint on referrals.referred_id (plus link_referral's own checks)
// makes a repeat call a harmless no-op.
async function linkPendingReferralIfAny(){
  var code=null;
  try{code=localStorage.getItem('gd_pending_ref_code');}catch(e){}
  if(!code||!currentUser)return;
  try{
    var r=await sb.rpc('link_referral',{p_ref_code:code});
    // BUG FIX: this used to clear the pending code unconditionally,
    // even when link_referral came back with r.error (invalid code,
    // transient DB error, etc.) — silently dropping the referral
    // forever with no retry and no record of why. Now the pending code
    // is only cleared once linking has actually succeeded; on error it
    // stays in localStorage so the very next login (this function runs
    // on every launchApp()) tries again instead of losing it.
    if(r&&r.error){
      console.warn('linkPendingReferralIfAny: link_referral failed, will retry next login:',r.error.message);
      return;
    }
    try{localStorage.removeItem('gd_pending_ref_code');}catch(e){}
  }catch(e){
    console.warn('linkPendingReferralIfAny:',e.message);
    // Thrown/network-level failure — also leave the pending code in
    // place so this retries next login rather than being lost.
  }
}

/* ── Realtime dashboard updates ──
   Keeps the referrer's own Refer & Earn page current the moment a
   referred signup / reward / balance change actually lands in the
   database — no manual refresh or re-navigation needed. Torn down and
   rebuilt fresh on every loadReferralPage() call (below) rather than
   left running indefinitely: that's the simplest way to keep it always
   scoped to whichever user is actually logged in right now, without
   this standalone module needing a hook into the main script's
   logout() to know when to clean up. */
var referralRealtimeCh=null;
function teardownReferralRealtime(){
  if(referralRealtimeCh){
    try{sb.removeChannel(referralRealtimeCh);}catch(e){}
    referralRealtimeCh=null;
  }
}
function isReferPageOpen(){
  var page=document.getElementById('pgRefer');
  return !!(page&&page.classList.contains('active'));
}
function setupReferralRealtime(){
  teardownReferralRealtime();
  if(!currentUser)return;
  function refreshIfOpen(){if(isReferPageOpen())loadReferralPage();}
  referralRealtimeCh=sb.channel('refer_dash_ch_'+currentUser.id)
    // A new row here IS "someone used my link/code and registered" —
    // this is what makes a fresh referral show up in the dashboard
    // live, with no refresh needed.
    .on('postgres_changes',
      {event:'INSERT',schema:'public',table:'referrals',filter:'referrer_id=eq.'+currentUser.id},
      refreshIfOpen
    )
    // Covers a referral later flipping to "qualified" (cash_reward_given).
    .on('postgres_changes',
      {event:'UPDATE',schema:'public',table:'referrals',filter:'referrer_id=eq.'+currentUser.id},
      refreshIfOpen
    )
    .on('postgres_changes',
      {event:'INSERT',schema:'public',table:'referral_rewards',filter:'referrer_id=eq.'+currentUser.id},
      refreshIfOpen
    )
    // Balance can change from a reward credit or a withdrawal being
    // approved/rejected — apply it directly and instantly, even if the
    // Refer page isn't the one currently open, so it's already correct
    // the moment they do open it.
    .on('postgres_changes',
      {event:'UPDATE',schema:'public',table:'profiles',filter:'id=eq.'+currentUser.id},
      function(p){
        if(!p.new||p.new.referral_balance===undefined)return;
        currentUser.referral_balance=+p.new.referral_balance||0;
        if(!isReferPageOpen())return;
        var balEl=document.getElementById('referBalance');
        if(balEl)balEl.textContent='\u20a6'+(currentUser.referral_balance||0).toLocaleString();
        var wdBtn=document.getElementById('referWithdrawBtn');
        if(wdBtn)wdBtn.disabled=(currentUser.referral_balance||0)<1000;
      }
    )
    .subscribe();
  // Hand the channel to the main app's channel registry when it's
  // present, so logout()'s existing clearRealtimeChannels() tears this
  // one down along with everything else. Harmless if that registry
  // isn't available — teardownReferralRealtime() above already
  // guarantees a clean removal+recreate on every loadReferralPage() call
  // regardless.
  if(typeof addCh==='function')addCh(referralRealtimeCh);
}

/* ── Referral page ── */
async function loadReferralPage(){
  if(!currentUser)return;
  setupReferralRealtime();
  var codeEl=document.getElementById('referCode');
  var linkEl=document.getElementById('referLink');
  var balEl=document.getElementById('referBalance');
  var totalEl=document.getElementById('referTotalCount');
  var qualEl=document.getElementById('referQualCount');
  var earnEl=document.getElementById('referTotalEarnings');
  var wdBtn=document.getElementById('referWithdrawBtn');
  [codeEl,linkEl,balEl,totalEl,qualEl,earnEl].forEach(function(el){if(el)el.textContent='···';});
  try{
    var pr=await sb.from('profiles')
      .select('referral_code,referral_balance,wd_bank,wd_acc_num,wd_acc_name')
      .eq('id',currentUser.id).single();
    if(pr.data){
      currentUser.referral_code=pr.data.referral_code||'';
      currentUser.referral_balance=+pr.data.referral_balance||0;
      currentUser.wd_bank=pr.data.wd_bank||'';
      currentUser.wd_acc_num=pr.data.wd_acc_num||'';
      currentUser.wd_acc_name=pr.data.wd_acc_name||'';
    }
    // Self-healing: an account created before the referral-code
    // trigger/backfill existed could still have a null referral_code.
    // Rather than show a blank code/link forever, generate one now and
    // save it — the ".is('referral_code',null)" guard means this can
    // never overwrite a code that's already set (including one set by a
    // concurrent tab/request in the same moment).
    if(!currentUser.referral_code){
      try{
        var gen=await sb.rpc('gen_referral_code');
        var newCode=Array.isArray(gen.data)?gen.data[0]:gen.data;
        if(!gen.error&&newCode){
          var upd=await sb.from('profiles').update({referral_code:newCode})
            .eq('id',currentUser.id).is('referral_code',null).select('referral_code').single();
          if(upd.data&&upd.data.referral_code)currentUser.referral_code=upd.data.referral_code;
        }
      }catch(e){console.warn('referral_code self-heal failed:',e.message);}
    }
    var link=window.location.origin+window.location.pathname+'?ref='+encodeURIComponent(currentUser.referral_code||'');
    if(codeEl)codeEl.textContent=currentUser.referral_code||'Unavailable — refresh to try again';
    if(linkEl)linkEl.textContent=currentUser.referral_code?link:'Unavailable — refresh to try again';
    if(balEl)balEl.textContent='\u20a6'+(currentUser.referral_balance||0).toLocaleString();

    var refs=await sb.from('referrals').select('cash_reward_given').eq('referrer_id',currentUser.id);
    var refRows=refs.data||[];
    if(totalEl)totalEl.textContent=refRows.length;
    if(qualEl)qualEl.textContent=refRows.filter(function(r){return r.cash_reward_given;}).length;

    var rewards=await sb.from('referral_rewards').select('reward_amount').eq('referrer_id',currentUser.id);
    var totalEarnings=(rewards.data||[]).reduce(function(s,r){return s+(+r.reward_amount||0);},0);
    if(earnEl)earnEl.textContent='\u20a6'+totalEarnings.toLocaleString();

    if(wdBtn)wdBtn.disabled=(currentUser.referral_balance||0)<1000;
  }catch(e){
    console.error('loadReferralPage failed:',e);
    toast('Could not load referral data');
  }
}
function copyReferralLink(){
  if(currentUser&&currentUser.referral_code){
    var link=window.location.origin+window.location.pathname+'?ref='+encodeURIComponent(currentUser.referral_code);
    copyText(link);
  }else{
    toast('Referral link not ready yet — try reloading the page');
  }
}
function copyReferralCode(){
  if(currentUser&&currentUser.referral_code)copyText(currentUser.referral_code);
  else toast('Referral code not ready yet — try reloading the page');
}
function openReferWithdrawModal(){
  if(!currentUser)return;
  if((currentUser.referral_balance||0)<1000){toast('Minimum referral withdrawal is \u20a61,000');return;}
  var bankEl=document.getElementById('referWdBank');if(bankEl)bankEl.value=currentUser.wd_bank||'';
  var accNumEl=document.getElementById('referWdAccNum');if(accNumEl)accNumEl.value=currentUser.wd_acc_num||'';
  var accNameEl=document.getElementById('referWdAccName');if(accNameEl)accNameEl.value=currentUser.wd_acc_name||'';
  var amtEl=document.getElementById('referWdAmount');if(amtEl){amtEl.value='';amtEl.max=currentUser.referral_balance||0;}
  var availEl=document.getElementById('referWdAvailable');
  if(availEl)availEl.textContent='Available: \u20a6'+(currentUser.referral_balance||0).toLocaleString();
  var ov=document.getElementById('referWdModalOv');if(ov)ov.classList.add('show');
  document.body.style.overflow='hidden';
}
function closeReferWithdrawModal(){
  var ov=document.getElementById('referWdModalOv');if(ov)ov.classList.remove('show');
  document.body.style.overflow='';
}
async function submitReferralWithdrawal(){
  var bank=(document.getElementById('referWdBank')||{}).value||'';
  var accNum=(document.getElementById('referWdAccNum')||{}).value||'';
  var accName=(document.getElementById('referWdAccName')||{}).value||'';
  var amount=+((document.getElementById('referWdAmount')||{}).value||0);
  if(!bank.trim()||!accNum.trim()||!accName.trim()){toast('Fill in your bank details');return;}
  if(!amount||amount<1000){toast('Minimum referral withdrawal is \u20a61,000');return;}
  if(amount>(currentUser.referral_balance||0)){toast('Amount exceeds your referral balance');return;}
  var btn=document.getElementById('referWdSubmitBtn');
  if(btn){btn.disabled=true;btn.textContent='Processing...';}
  try{
    var r=await sb.rpc('request_referral_withdrawal',{
      p_user_id:currentUser.id,p_amount:amount,p_bank:bank.trim(),p_acc_num:accNum.trim(),p_acc_name:accName.trim()
    });
    var row=Array.isArray(r.data)?r.data[0]:r.data;
    if(r.error||!row||!row.success){
      toast((row&&row.message)||(r.error&&r.error.message)||'Withdrawal request failed');
      return;
    }
    currentUser.referral_balance=row.new_balance;
    closeReferWithdrawModal();
    toast('Withdrawal request submitted \u2014 pending admin approval');
    loadReferralPage();
  }catch(e){
    toast(e.message||'Withdrawal request failed');
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Submit Withdrawal Request';}
  }
}
