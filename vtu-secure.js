/* ══════════════════════════════════════════════════════════════════
   GlobalDigits — VTU SECURE MODULE  (vtu-secure.js)
   ══════════════════════════════════════════════════════════════════
   Self-contained add-on. Loaded AFTER the main inline <script> in
   index.html, so it can freely use the globals that script already
   defines: sb, currentUser, vtuCatalog, loadVtuCatalog(),
   findProviderId(), getDataBundles(), parseSizeToMB(),
   formatSizeDisplay(), classifyDuration(), classifyDataCategory(),
   debitForPurchase(), refundPurchase(), callRapidBills(),
   loadVtuHistory(), nav(), closeSidebar(), toast(), fmtDate(),
   fmtTime(), cap(), generateUUID().

   This file does NOT touch the existing #pgVtu ("Airtime & Data")
   page or any of its functions/state (currentNetwork, currentDataNetwork,
   selectedAirtimeAmt, buyAirtime(), buyData(), payCable(),
   payElectricity(), etc.) — that page keeps working exactly as
   before, reachable from the sidebar / dashboard carousel / Pet.
   Everything here uses its own "vtu2*" state and element ids so the
   two pages can never collide.

   Requires the SQL in vtu_pin_migration.sql to have been run once —
   this file only ever calls the RPCs it defines (vtu_pin_status,
   set_vtu_pin, verify_vtu_pin, change_vtu_pin, reset_vtu_pin). The
   PIN itself never touches this file except as a value the user just
   typed, sent straight to an RPC — it is never stored, logged, or
   read back from anywhere in the frontend.

   index.html was touched in exactly three places to wire this in:
     1. A 6th Quick Action button ("VTU") calling openVtu2().
     2. One Settings card ("VTU Security PIN") calling vtu2OpenSettingsPin().
     3. <script src="vtu-secure.js"></script> before </body>.
   Nothing else in the site was modified.
   ══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* ══ STATE ══ */
var V2 = {
  tab:'airtime',
  network:'MTN',              // airtime
  dataNetwork:'MTN', duration:'daily', category:'sme', selectedPlan:null,
  selectedAirtimeAmt:0,
  cable:'DSTV',
  disco:'', meterType:1, selectedElecAmt:0,
  pinHasPin:null,              // null = unknown yet, true/false once checked against the DB
  pendingAfterPin:null,        // function to run once PIN is verified
  forgotCtx:null,               // 'purchase' | 'settings' — where to return to after a reset
  resendTimer:null              // interval id for the forgot-PIN email resend countdown
};

/* ══ SMALL DOM HELPERS ══ */
function $(id){return document.getElementById(id);}
function qs(sel,root){return (root||document).querySelector(sel);}
function qsa(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}

/* ══════════════════════════════════════════════════════════════════
   1. STYLES — everything else reuses the app's existing classes
   (.formCard, .fG, .fI, .btn/.btnP/.btnOutline, .mOverlay/.mBox,
   .netGrid/.netBtn, .amtGrid/.amtChip, .chipRow/.chip, .dataGrid,
   .cableProvGrid/.cProvBtn, .meterTypeRow/.meterBtn, .vtuSummary,
   .gdQuickBtn/.gdQuickIcon). Only the genuinely new bits are styled
   here, and only using the app's existing CSS variables.
   ══════════════════════════════════════════════════════════════════ */
var css = ''
+'.vtu2Head{display:flex;align-items:center;gap:10px;margin-bottom:14px;}'
+'.vtu2BackBtn{width:32px;height:32px;border-radius:50%;border:1.5px solid var(--border);background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;color:var(--text2);}'
+'.vtu2Head h2{font-family:var(--font-d);font-size:16px;font-weight:600;margin:0;}'
+'.vtu2Head p{font-size:10.5px;color:var(--text2);margin-top:1px;}'
+'.vtu2NoticeCard{display:flex;gap:10px;align-items:flex-start;background:var(--brand-lt);border:1px solid var(--ring-lt);border-radius:14px;padding:13px;margin-bottom:14px;}'
+'.vtu2NoticeIcon{width:34px;height:34px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;}'
+'.vtu2NoticeCard strong{font-size:12.5px;display:block;margin-bottom:2px;}'
+'.vtu2NoticeCard span{font-size:11px;color:var(--text2);line-height:1.4;display:block;margin-bottom:8px;}'
+'.vtu2Lock{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--brand);color:#fff;position:absolute;top:-3px;right:-3px;}'
+'.vtu2QaWrap{position:relative;}'
+'.vtu2PinBoxes{display:flex;gap:10px;justify-content:center;margin:18px 0 6px;}'
+'.vtu2PinBox{width:46px;height:52px;border:1.5px solid var(--border);border-radius:12px;text-align:center;font-size:22px;font-weight:700;font-family:var(--font-d);color:var(--text);outline:none;background:var(--bg);transition:border-color var(--t),box-shadow var(--t);}'
+'.vtu2PinBox:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--ring-lt);background:#fff;}'
+'.vtu2PinBox.err{border-color:var(--danger);}'
+'.vtu2PinBoxes.sm .vtu2PinBox{width:40px;height:46px;font-size:18px;border-radius:10px;}'
+'.vtu2PinErr{text-align:center;font-size:11.5px;color:var(--danger);min-height:15px;margin-bottom:6px;}'
+'.vtu2PinMsg{text-align:center;font-size:11px;color:var(--text2);margin-bottom:2px;}'
+'.vtu2PinIconWrap{width:60px;height:60px;border-radius:50%;background:var(--brand-lt);color:var(--brand);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;}'
+'.vtu2ForgotLink{display:block;text-align:center;font-size:11.5px;font-weight:700;color:var(--brand);margin-top:10px;cursor:pointer;}'
+'.vtu2Btn{width:100%;height:46px;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:background var(--t),box-shadow var(--t),border-color var(--t),color var(--t);font-family:var(--font);}'
+'.vtu2Btn:active{transform:scale(.98);}'
+'.vtu2Btn+.vtu2Btn{margin-top:8px;}'
+'.vtu2BtnP{background:var(--brand);color:#fff;box-shadow:0 4px 14px rgba(26,86,219,.18);}'
+'.vtu2BtnP:hover{background:var(--brand-dk);}'
+'.vtu2BtnP:disabled{opacity:.6;cursor:not-allowed;box-shadow:none;}'
+'.vtu2BtnO{background:#fff;border:1.5px solid var(--border);color:var(--text2);}'
+'.vtu2BtnO:hover{border-color:var(--brand);color:var(--brand);}'
+'.vtu2ModalClose{position:absolute;top:14px;right:14px;width:28px;height:28px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;color:var(--text2);cursor:pointer;z-index:1;}'
+'.vtu2ModalHead{text-align:center;margin-bottom:16px;padding-top:2px;}'
+'.vtu2ModalHead h3{font-family:var(--font-d);font-size:15.5px;font-weight:600;margin-bottom:4px;}'
+'.vtu2ModalHead p{font-size:11px;color:var(--text2);line-height:1.45;padding:0 6px;}'
+'.vtu2EmailCard{display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:11px 12px;margin-bottom:16px;}'
+'.vtu2EmailIcon{width:32px;height:32px;border-radius:50%;background:var(--brand-lt);color:var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;}'
+'.vtu2EmailCard div{min-width:0;}'
+'.vtu2EmailCard b{display:block;font-size:9.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:1px;}'
+'.vtu2EmailCard span{display:block;font-size:11.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
+'.vtu2ResendRow{text-align:center;font-size:10.5px;color:var(--text2);margin-top:10px;}'
+'.vtu2ResendRow a{color:var(--brand);font-weight:700;cursor:pointer;}'
+'.vtu2ResendRow a.disabled{color:var(--text3);cursor:default;pointer-events:none;}'
+'.vtu2FieldLabel{font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.03em;margin:14px 0 8px;text-align:center;}'
+'.vtu2FieldLabel:first-child{margin-top:0;}'
+'.vtu2SuccessWrap{text-align:center;padding:4px 0 2px;}'
+'.vtu2SuccessIconWrap{width:60px;height:60px;border-radius:50%;background:#dcfce7;color:#16a34a;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;}'
+'.vtu2SuccessWrap h3{font-family:var(--font-d);font-size:15.5px;font-weight:600;margin-bottom:5px;}'
+'.vtu2SuccessWrap p{font-size:11.5px;color:var(--text2);margin-bottom:18px;}'
+'.vtu2ReceiptWrap{text-align:center;padding:14px 0 6px;}'
+'.vtu2ReceiptIconWrap{width:92px;height:92px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}'
+'.vtu2ReceiptWrap h2{font-family:var(--font-d);font-size:18px;font-weight:600;margin-bottom:6px;}'
+'.vtu2ReceiptWrap>p{font-size:12.5px;color:var(--text2);margin-bottom:18px;}'
+'.vtu2ReceiptCard{background:var(--surface2);border-radius:14px;padding:4px 14px;text-align:left;margin-bottom:18px;}'
+'.vtu2ReceiptRow{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--border);font-size:12.5px;}'
+'.vtu2ReceiptRow:last-child{border-bottom:none;}'
+'.vtu2ReceiptRow span:first-child{color:var(--text2);}'
+'.vtu2ReceiptRow span:last-child{font-weight:600;text-align:right;}'
+'.vtu2ReceiptRow.tot span:last-child{color:var(--brand);font-family:var(--font-d);font-size:14px;}'
+'.vtu2SettingsStatus{display:flex;align-items:center;gap:9px;background:#e3f9ec;border-radius:12px;padding:10px 12px;margin-bottom:14px;}'
+'.vtu2SettingsStatus svg{flex-shrink:0;}'
+'.vtu2SettingsStatus b{font-size:12px;color:#16a34a;display:block;}'
+'.vtu2SettingsStatus span{font-size:10.5px;color:var(--text2);}'
+'.vtu2Otp6{display:flex;gap:7px;justify-content:center;margin:16px 0 6px;}'
+'.vtu2Otp6 input{width:38px;height:46px;border:1.5px solid var(--border);border-radius:10px;text-align:center;font-size:17px;font-weight:700;font-family:var(--font-d);outline:none;}'
+'.vtu2Otp6 input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--ring-lt);}';
var styleEl = document.createElement('style');
styleEl.id = 'vtu2Styles';
styleEl.textContent = css;
document.head.appendChild(styleEl);

/* ══════════════════════════════════════════════════════════════════
   2. MARKUP — injected into #mainContent as ordinary .page.pageArea
   elements, exactly like every other page in the app, so the shared
   nav()/topbar/bottom-nav shell keeps working around them untouched.
   ══════════════════════════════════════════════════════════════════ */
function svgBack(){return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="15 18 9 12 15 6"/></svg>';}
function svgLock(sz){return '<svg width="'+(sz||14)+'" height="'+(sz||14)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';}
function svgCheck(sz,color){return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="'+color+'" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';}
function svgShield(){return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';}
function svgX(){return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';}
function svgMail(sz){return '<svg width="'+(sz||14)+'" height="'+(sz||14)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/></svg>';}
function vtuTypeSvg(type){
  var icons={
    airtime:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
    data:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1.05 12a11 11 0 0121.9 0"/><path d="M5 12a7 7 0 0114 0"/><path d="M9 12a3 3 0 016 0"/></svg>',
    cable:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
    electricity:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
  };
  return icons[type]||icons.airtime;
}

var mainPageHtml =
'<div id="pgVtu2" class="page pageArea">'
+'  <div class="vtu2Head">'
+'    <button class="vtu2BackBtn" onclick="Vtu2.back()" aria-label="Back">'+svgBack()+'</button>'
+'    <div><h2>VTU Services</h2><p>Buy airtime, data and more</p></div>'
+'  </div>'
+'  <div id="vtu2Notice" class="vtu2NoticeCard hidden">'
+'    <div class="vtu2NoticeIcon">'+svgLock(15)+'</div>'
+'    <div style="flex:1">'
+'      <strong>Secure VTU purchases</strong>'
+'      <span>Set your 4-digit PIN before purchasing VTU services.</span>'
+'      <button class="btn btnP" style="padding:7px 16px;font-size:11.5px" onclick="Vtu2.goSetPin()">Set PIN</button>'
+'    </div>'
+'  </div>'
+'  <div class="chipRow" id="vtu2Tabs">'
+'    <button class="chip active" data-t="airtime" onclick="Vtu2.switchTab(\'airtime\',this)">Airtime</button>'
+'    <button class="chip" data-t="data" onclick="Vtu2.switchTab(\'data\',this)">Data</button>'
+'    <button class="chip" data-t="cable" onclick="Vtu2.switchTab(\'cable\',this)">Cable TV</button>'
+'    <button class="chip" data-t="electricity" onclick="Vtu2.switchTab(\'electricity\',this)">Electricity</button>'
+'  </div>'

/* ── AIRTIME ── */
+'  <div id="vtu2Airtime">'
+'    <div class="formCard">'
+'      <div class="settingsCardHead"><div class="settingsCardIcon">'+vtuTypeSvg('airtime')+'</div>'
+'        <div><h3 style="font-size:13px">Airtime</h3><p style="font-size:10px;color:var(--text2);margin-top:1px">Instant top-up, all networks</p></div></div>'
+'      <div class="fG"><label>Network</label><div class="netGrid">'
+'        <button class="netBtn active" onclick="Vtu2.selectNetwork(\'MTN\',this)"><div class="netLogo nl-mtn">MTN</div><span>MTN</span></button>'
+'        <button class="netBtn" onclick="Vtu2.selectNetwork(\'GLO\',this)"><div class="netLogo nl-glo">GLO</div><span>Glo</span></button>'
+'        <button class="netBtn" onclick="Vtu2.selectNetwork(\'AIRTEL\',this)"><div class="netLogo nl-air">AIR</div><span>Airtel</span></button>'
+'        <button class="netBtn" onclick="Vtu2.selectNetwork(\'9MOBILE\',this)"><div class="netLogo nl-9mob">9MB</div><span>9mobile</span></button>'
+'      </div></div>'
+'      <div class="fG"><label>Phone Number</label><input type="tel" id="vtu2AirtimePhone" class="fI" placeholder="08012345678" maxlength="11" oninput="this.value=this.value.replace(/\\D/g,\'\')"/></div>'
+'      <div class="fG"><label>Amount</label><div class="amtGrid">'
+'        <div class="amtChip" onclick="Vtu2.selectAirtimeAmt(100,this)">₦100</div>'
+'        <div class="amtChip" onclick="Vtu2.selectAirtimeAmt(200,this)">₦200</div>'
+'        <div class="amtChip" onclick="Vtu2.selectAirtimeAmt(500,this)">₦500</div>'
+'        <div class="amtChip" onclick="Vtu2.selectAirtimeAmt(1000,this)">₦1,000</div>'
+'        <div class="amtChip" onclick="Vtu2.selectAirtimeAmt(2000,this)">₦2,000</div>'
+'        <div class="amtChip" onclick="Vtu2.selectAirtimeAmt(5000,this)">₦5,000</div>'
+'      </div><input type="number" id="vtu2AirtimeAmt" class="fI" placeholder="Or enter custom amount (min ₦100)" oninput="Vtu2.clearAirtimeChips();Vtu2.updateAirtimeSummary()" min="100" style="margin-top:8px"/>'
+'      <div class="vtuChargeNote">A ₦10 service charge applies per purchase</div></div>'
+'      <div class="vtuSummary" id="vtu2AirtimeSummary" style="display:none"><div><div id="vtu2AirtimeSummaryText" style="font-weight:500;font-size:13px"></div><div style="font-size:11px;color:var(--text2);margin-top:2px">wallet deduction</div></div><div class="vtuSummAmt" id="vtu2AirtimeSummaryAmt">₦0</div></div>'
+'      <button class="btn btnP" style="width:100%" onclick="Vtu2.confirmAirtime()">Buy Airtime</button>'
+'    </div>'
+'  </div>'

/* ── DATA ── */
+'  <div id="vtu2Data" class="hidden">'
+'    <div class="formCard">'
+'      <div class="settingsCardHead"><div class="settingsCardIcon">'+vtuTypeSvg('data')+'</div>'
+'        <div><h3 style="font-size:13px">Data</h3><p style="font-size:10px;color:var(--text2);margin-top:1px">Choose a category and plan that fits you</p></div></div>'
+'      <div class="fG"><label>Network</label><div class="netGrid">'
+'        <button class="netBtn active" onclick="Vtu2.selectDataNetwork(\'MTN\',this)"><div class="netLogo nl-mtn">MTN</div><span>MTN</span></button>'
+'        <button class="netBtn" onclick="Vtu2.selectDataNetwork(\'GLO\',this)"><div class="netLogo nl-glo">GLO</div><span>Glo</span></button>'
+'        <button class="netBtn" onclick="Vtu2.selectDataNetwork(\'AIRTEL\',this)"><div class="netLogo nl-air">AIR</div><span>Airtel</span></button>'
+'        <button class="netBtn" onclick="Vtu2.selectDataNetwork(\'9MOBILE\',this)"><div class="netLogo nl-9mob">9MB</div><span>9mobile</span></button>'
+'      </div></div>'
+'      <div class="fG"><label>Phone Number</label><input type="tel" id="vtu2DataPhone" class="fI" placeholder="08012345678" maxlength="11" oninput="this.value=this.value.replace(/\\D/g,\'\')"/></div>'
+'      <div class="fG"><label>Duration</label><div class="chipRow" id="vtu2DurTabs">'
+'        <button class="chip active" onclick="Vtu2.selectDuration(\'daily\',this)">Daily</button>'
+'        <button class="chip" onclick="Vtu2.selectDuration(\'weekly\',this)">Weekly</button>'
+'        <button class="chip" onclick="Vtu2.selectDuration(\'monthly\',this)">Monthly</button>'
+'      </div></div>'
+'      <div class="fG"><label>Data Category</label><div class="chipRow chipRowScroll" id="vtu2CatTabs">'
+'        <button class="chip active" onclick="Vtu2.selectCategory(\'sme\',this)">SME Data</button>'
+'        <button class="chip" onclick="Vtu2.selectCategory(\'cg\',this)">CG Data</button>'
+'        <button class="chip" onclick="Vtu2.selectCategory(\'awoof\',this)">Awoof Data</button>'
+'        <button class="chip" onclick="Vtu2.selectCategory(\'sharing\',this)">Data Sharing</button>'
+'        <button class="chip" onclick="Vtu2.selectCategory(\'gifting\',this)">Data Gifting</button>'
+'        <button class="chip" onclick="Vtu2.selectCategory(\'special\',this)">Special Data</button>'
+'      </div></div>'
+'      <div class="fG"><label>Select Plan</label><div class="dataGrid" id="vtu2DataPlansGrid"><p class="empty" style="grid-column:1/-1">Loading plans...</p></div></div>'
+'      <div class="vtuSummary" id="vtu2DataSummary" style="display:none"><div><div id="vtu2DataSummaryText" style="font-weight:500;font-size:13px"></div><div style="font-size:11px;color:var(--text2);margin-top:2px">wallet deduction</div></div><div class="vtuSummAmt" id="vtu2DataSummaryAmt">₦0</div></div>'
+'      <button class="btn btnP" style="width:100%" onclick="Vtu2.confirmData()">Buy Data</button>'
+'    </div>'
+'  </div>'

/* ── CABLE ── */
+'  <div id="vtu2Cable" class="hidden">'
+'    <div class="formCard">'
+'      <div class="settingsCardHead"><div class="settingsCardIcon">'+vtuTypeSvg('cable')+'</div>'
+'        <div><h3 style="font-size:13px">Cable TV</h3><p style="font-size:10px;color:var(--text2);margin-top:1px">Renew your subscription instantly</p></div></div>'
+'      <div class="fG"><label>Provider</label><div class="cableProvGrid">'
+'        <button class="cProvBtn active" onclick="Vtu2.selectCable(\'DSTV\',this)">DStv</button>'
+'        <button class="cProvBtn" onclick="Vtu2.selectCable(\'GOTV\',this)">GOtv</button>'
+'        <button class="cProvBtn" onclick="Vtu2.selectCable(\'STARTIMES\',this)">StarTimes</button>'
+'      </div></div>'
+'      <div class="fG"><label>Smartcard Number</label><input type="text" id="vtu2CableCard" class="fI" placeholder="Enter smartcard / IUC number"/></div>'
+'      <div class="fG"><label>Package</label><select id="vtu2CablePlan" class="fI" onchange="Vtu2.updateCableSummary()"><option value="">-- Loading packages... --</option></select></div>'
+'      <div class="vtuSummary" id="vtu2CableSummary" style="display:none"><div><div id="vtu2CableSummaryText" style="font-weight:500;font-size:13px"></div><div style="font-size:11px;color:var(--text2);margin-top:2px">wallet deduction</div></div><div class="vtuSummAmt" id="vtu2CableSummaryAmt">₦0</div></div>'
+'      <button class="btn btnP" style="width:100%" onclick="Vtu2.confirmCable()">Pay Subscription</button>'
+'    </div>'
+'  </div>'

/* ── ELECTRICITY ── */
+'  <div id="vtu2Electricity" class="hidden">'
+'    <div class="formCard">'
+'      <div class="settingsCardHead"><div class="settingsCardIcon">'+vtuTypeSvg('electricity')+'</div>'
+'        <div><h3 style="font-size:13px">Electricity</h3><p style="font-size:10px;color:var(--text2);margin-top:1px">Get your prepaid or postpaid token</p></div></div>'
+'      <div class="fG"><label>Electricity Provider</label><select id="vtu2Disco" class="fI" onchange="Vtu2.selectDisco(this.value)">'
+'        <option value="">-- Select Provider --</option>'
+'        <option value="IKEDC">IKEDC — Ikeja Electric</option><option value="EKEDC">EKEDC — Eko Electric</option>'
+'        <option value="KEDCO">KEDCO — Kano Electric</option><option value="PHED">PHED — Port Harcourt Electric</option>'
+'        <option value="JED">JED — Jos Electric</option><option value="AEDC">AEDC — Abuja Electric</option>'
+'        <option value="KAEDCO">KAEDCO — Kaduna Electric</option><option value="EEDC">EEDC — Enugu Electric</option>'
+'        <option value="BEDC">BEDC — Benin Electric</option><option value="YEDC">YEDC — Yola Electric</option>'
+'      </select></div>'
+'      <div class="fG"><label>Meter Type</label><div class="meterTypeRow">'
+'        <button class="meterBtn active" onclick="Vtu2.selectMeterType(1,this)">Prepaid</button>'
+'        <button class="meterBtn" onclick="Vtu2.selectMeterType(2,this)">Postpaid</button>'
+'      </div></div>'
+'      <div class="fG"><label>Meter Number</label><input type="text" id="vtu2Meter" class="fI" placeholder="Enter meter number"/></div>'
+'      <div class="fG"><label>Phone Number</label><input type="tel" id="vtu2ElecPhone" class="fI" placeholder="08012345678" maxlength="11" oninput="this.value=this.value.replace(/\\D/g,\'\')"/></div>'
+'      <div class="fG"><label>Amount (₦)</label><div class="amtGrid">'
+'        <div class="amtChip" onclick="Vtu2.selectElecAmt(1000,this)">₦1,000</div><div class="amtChip" onclick="Vtu2.selectElecAmt(2000,this)">₦2,000</div>'
+'        <div class="amtChip" onclick="Vtu2.selectElecAmt(5000,this)">₦5,000</div><div class="amtChip" onclick="Vtu2.selectElecAmt(10000,this)">₦10,000</div>'
+'        <div class="amtChip" onclick="Vtu2.selectElecAmt(20000,this)">₦20,000</div><div class="amtChip" onclick="Vtu2.selectElecAmt(50000,this)">₦50,000</div>'
+'      </div><input type="number" id="vtu2ElecAmt" class="fI" placeholder="Or enter custom amount (min ₦500)" oninput="Vtu2.clearElecChips()" min="500" style="margin-top:8px"/></div>'
+'      <button class="btn btnP" style="width:100%" onclick="Vtu2.confirmElectricity()">Buy Token</button>'
+'    </div>'
+'  </div>'
+'</div>';

var receiptPageHtml =
'<div id="pgVtu2Receipt" class="page pageArea">'
+'  <div class="vtu2ReceiptWrap">'
+'    <div class="vtu2ReceiptIconWrap">'+svgCheck(46,'#16a34a')+'</div>'
+'    <h2>VTU Purchase Successful</h2>'
+'    <p id="vtu2RxMsg">Your purchase has been delivered successfully.</p>'
+'    <div class="vtu2ReceiptCard">'
+'      <div class="vtu2ReceiptRow"><span>Service</span><span id="vtu2RxService">—</span></div>'
+'      <div class="vtu2ReceiptRow" id="vtu2RxNetworkRow"><span id="vtu2RxNetworkLbl">Network</span><span id="vtu2RxNetwork">—</span></div>'
+'      <div class="vtu2ReceiptRow hidden" id="vtu2RxDestRow"><span id="vtu2RxDestLbl">Phone Number</span><span id="vtu2RxDest">—</span></div>'
+'      <div class="vtu2ReceiptRow hidden" id="vtu2RxTokenRow"><span>Token</span><span id="vtu2RxToken">—</span></div>'
+'      <div class="vtu2ReceiptRow"><span>Amount</span><span id="vtu2RxAmount">₦0</span></div>'
+'      <div class="vtu2ReceiptRow"><span>Service Charge</span><span id="vtu2RxFee">₦0</span></div>'
+'      <div class="vtu2ReceiptRow tot"><span>Total</span><span id="vtu2RxTotal">₦0</span></div>'
+'      <div class="vtu2ReceiptRow"><span>Transaction ID</span><span id="vtu2RxTxid">—</span></div>'
+'      <div class="vtu2ReceiptRow"><span>Date &amp; Time</span><span id="vtu2RxDate">—</span></div>'
+'    </div>'
+'    <button class="btn btnP" style="width:100%" onclick="Vtu2.doneReceipt()">Done</button>'
+'  </div>'
+'</div>';

var modalsHtml =
/* PIN entry modal — shown before any purchase completes, when a PIN already exists */
'<div id="vtu2PinModal" class="mOverlay hidden" onclick="if(event.target===this)Vtu2.closePinModal()">'
+'  <div class="mBox" style="max-width:320px;position:relative">'
+'    <button class="vtu2ModalClose" onclick="Vtu2.closePinModal()" aria-label="Close">'+svgX()+'</button>'
+'    <div class="vtu2ModalHead">'
+'      <div class="vtu2PinIconWrap">'+svgLock(24)+'</div>'
+'      <h3>Enter your 4-digit PIN</h3>'
+'      <p>Confirm your PIN to continue this purchase.</p>'
+'    </div>'
+'    <div class="vtu2PinBoxes" id="vtu2PinBoxes">'
+'      <input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>'
+'      <input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>'
+'      <input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>'
+'      <input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>'
+'    </div>'
+'    <div class="vtu2PinErr" id="vtu2PinErr"></div>'
+'    <button class="vtu2Btn vtu2BtnP" id="vtu2PinConfirmBtn" onclick="Vtu2.verifyPinAndProceed()">Confirm</button>'
+'    <a class="vtu2ForgotLink" onclick="Vtu2.startForgotPin(\'purchase\')">Forgot PIN?</a>'
+'  </div>'
+'</div>'

/* No-PIN-yet notice, shown when a purchase is attempted with no PIN set */
+'<div id="vtu2NoPinModal" class="mOverlay hidden" onclick="if(event.target===this)Vtu2.closeNoPinModal()">'
+'  <div class="mBox" style="max-width:320px;position:relative">'
+'    <button class="vtu2ModalClose" onclick="Vtu2.closeNoPinModal()" aria-label="Close">'+svgX()+'</button>'
+'    <div class="vtu2ModalHead">'
+'      <div class="vtu2PinIconWrap">'+svgLock(24)+'</div>'
+'      <h3>Secure your VTU purchases</h3>'
+'      <p>Set your 4-digit PIN before purchasing VTU services.</p>'
+'    </div>'
+'    <button class="vtu2Btn vtu2BtnP" onclick="Vtu2.goSetPin()">Set PIN</button>'
+'    <button class="vtu2Btn vtu2BtnO" onclick="Vtu2.closeNoPinModal()">Cancel</button>'
+'  </div>'
+'</div>'

/* Settings — status / create / change PIN */
+'<div id="vtu2SettingsModal" class="mOverlay hidden" onclick="if(event.target===this)Vtu2.closeSettingsModal()">'
+'  <div class="mBox" style="max-width:340px;position:relative">'
+'    <button class="vtu2ModalClose" onclick="Vtu2.closeSettingsModal()" aria-label="Close">'+svgX()+'</button>'
+'    <div class="vtu2ModalHead">'
+'      <div class="vtu2PinIconWrap">'+svgLock(24)+'</div>'
+'      <h3>VTU Security PIN</h3>'
+'      <p>Protect your airtime, data, cable &amp; electricity purchases.</p>'
+'    </div>'
+'    <div id="vtu2SettingsBody"><p style="font-size:12px;color:var(--text2);text-align:center">Checking your PIN status…</p></div>'
+'  </div>'
+'</div>'

/* Forgot PIN — reuses the existing recovery-email verification API, then create a new PIN */
+'<div id="vtu2ForgotModal" class="mOverlay hidden" onclick="if(event.target===this)Vtu2.closeForgotModal()">'
+'  <div class="mBox" style="max-width:340px;position:relative">'
+'    <button class="vtu2ModalClose" onclick="Vtu2.closeForgotModal()" aria-label="Close">'+svgX()+'</button>'
+'    <div id="vtu2ForgotBody"></div>'
+'  </div>'
+'</div>';

document.addEventListener('DOMContentLoaded', function(){ injectMarkup(); });
if(document.readyState==='complete'||document.readyState==='interactive') injectMarkup();

function injectMarkup(){
  if($('pgVtu2'))return; // already injected (guards against double-load)
  var main = $('mainContent');
  if(!main)return;
  var wrap = document.createElement('div');
  wrap.innerHTML = mainPageHtml + receiptPageHtml;
  while(wrap.firstChild) main.appendChild(wrap.firstChild);
  document.body.insertAdjacentHTML('beforeend', modalsHtml);
  wirePinBoxAutoAdvance();
}

/* Auto-advance / backspace / paste behaviour for the 4-digit PIN boxes.
   Generalised so it can wire any box group (purchase PIN, create PIN,
   change PIN, reset PIN, 6-digit email code) — each group keeps its
   own element id, this just adds the same input behaviour to all of
   them. Safe to call more than once on the same container; it only
   ever attaches listeners to inputs, never changes app logic. */
function wirePinBoxAutoAdvance(){ wireBoxGroup('#vtu2PinBoxes'); }
function wireBoxGroup(containerSel){
  var boxes = qsa(containerSel+' input');
  boxes.forEach(function(b,i){
    b.addEventListener('input', function(){
      b.value = b.value.replace(/\D/g,'').slice(0,1);
      b.classList.remove('err');
      if(b.value && boxes[i+1]) boxes[i+1].focus();
    });
    b.addEventListener('keydown', function(e){
      if(e.key==='Backspace' && !b.value && boxes[i-1]){ boxes[i-1].focus(); }
    });
    b.addEventListener('paste', function(e){
      e.preventDefault();
      var text=((e.clipboardData||window.clipboardData).getData('text')||'').replace(/\D/g,'');
      if(!text)return;
      for(var j=0;j<boxes.length;j++){ boxes[j].value=text[j]||''; }
      var next=boxes[Math.min(text.length,boxes.length)-1]||boxes[boxes.length-1];
      if(next)next.focus();
    });
  });
  return boxes;
}
function boxGroupValue(containerSel){
  return qsa(containerSel+' input').map(function(b){return b.value;}).join('');
}
function boxGroupClear(containerSel,focusFirst){
  var boxes=qsa(containerSel+' input');
  boxes.forEach(function(b){b.value='';b.classList.remove('err');});
  if(focusFirst&&boxes[0])setTimeout(function(){boxes[0].focus();},50);
}
function boxGroupErr(containerSel){
  qsa(containerSel+' input').forEach(function(b){b.classList.add('err');b.value='';});
  var f=qs(containerSel+' input'); if(f)f.focus();
}

/* ══════════════════════════════════════════════════════════════════
   3. PAGE OPEN / NAVIGATION (self-contained — doesn't touch nav())
   ══════════════════════════════════════════════════════════════════ */
function openVtu2(){
  if(!currentUser){toast('Please log in first');return;}
  qsa('.page').forEach(function(p){p.classList.remove('active');});
  var el=$('pgVtu2'); if(el)el.classList.add('active');
  var tt=$('topbarTitle'); if(tt)tt.textContent='VTU Services';
  var tb=$('topbar'); if(tb)tb.classList.remove('topbar--dash');
  if(typeof closeSidebar==='function')closeSidebar();
  window.scrollTo(0,0);
  refreshPinStatus().then(renderNotice);
  if(typeof loadVtuCatalog==='function'){
    loadVtuCatalog().then(function(){ renderDataPlans(); renderCablePlans(); });
  }
}
function back(){
  if(typeof nav==='function')nav('dashboard');
}

/* ══════════════════════════════════════════════════════════════════
   4. TABS
   ══════════════════════════════════════════════════════════════════ */
function switchTab(tab,el){
  V2.tab=tab;
  qsa('#vtu2Tabs .chip').forEach(function(c){c.classList.remove('active');});
  if(el)el.classList.add('active');
  ['Airtime','Data','Cable','Electricity'].forEach(function(s){
    var d=$('vtu2'+s); if(d)d.classList.add('hidden');
  });
  var show=$('vtu2'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(show)show.classList.remove('hidden');
}

/* ══════════════════════════════════════════════════════════════════
   5. AIRTIME
   ══════════════════════════════════════════════════════════════════ */
function selectNetwork(net,el){
  V2.network=net;
  qsa('#vtu2Airtime .netBtn').forEach(function(b){b.classList.remove('active');});
  if(el)el.classList.add('active');
}
function selectAirtimeAmt(amt,el){
  V2.selectedAirtimeAmt=amt;
  qsa('#vtu2Airtime .amtChip').forEach(function(c){c.classList.remove('active');});
  if(el)el.classList.add('active');
  var i=$('vtu2AirtimeAmt'); if(i)i.value='';
  updateAirtimeSummary();
}
function clearAirtimeChips(){V2.selectedAirtimeAmt=0;qsa('#vtu2Airtime .amtChip').forEach(function(c){c.classList.remove('active');});}
function updateAirtimeSummary(){
  var custom=parseFloat(($('vtu2AirtimeAmt')||{}).value||0)||0;
  var amt=V2.selectedAirtimeAmt||custom;
  var s=$('vtu2AirtimeSummary'), t=$('vtu2AirtimeSummaryText'), a=$('vtu2AirtimeSummaryAmt');
  if(amt>0&&s){
    s.style.display='flex';
    if(t)t.textContent=V2.network+' Airtime (₦'+amt.toLocaleString()+' + ₦10 charge)';
    if(a)a.textContent='₦'+(amt+10).toLocaleString();
  }else if(s)s.style.display='none';
}
function confirmAirtime(){
  var phone=($('vtu2AirtimePhone')||{}).value||'';
  var custom=parseFloat(($('vtu2AirtimeAmt')||{}).value||0)||0;
  var amount=V2.selectedAirtimeAmt||custom;
  if(!phone||phone.length<11){toast('Enter a valid 11-digit phone number');return;}
  if(!amount||amount<100){toast('Minimum airtime is ₦100');return;}
  var total=amount+10;
  if((currentUser.balance||0)<total){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  gatePin(function(){ executeAirtime(phone,amount,V2.network); });
}
async function executeAirtime(phone,amount,network){
  var CHARGE=10, total=amount+CHARGE;
  if(!vtuCatalog)await loadVtuCatalog();
  var providerId=vtuCatalog?findProviderId(vtuCatalog,'airtime',network):null;
  if(!providerId){toast('Could not find '+network+' provider. Please try again shortly.');return;}
  var btn=qs('#vtu2Airtime .btn.btnP');
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Buying...';}
  var description=network+' Airtime ₦'+amount.toLocaleString()+' → '+phone;
  var debit=await debitForPurchase(total,'vtu',description);
  if(!debit.success){ if(btn){btn.disabled=false;btn.textContent='Buy Airtime';} toast(debit.message);return; }
  var r=await callRapidBills('/buy-airtime/',{provider_id:providerId,number:phone,amount,wallet:'main'},'airtime');
  if(btn){btn.disabled=false;btn.textContent='Buy Airtime';}
  if(!r.success){ await refundPurchase(total,debit.clientRef,'Refund — Airtime purchase failed'); toast('❌ '+r.message+' — you have been refunded'); return; }
  await saveRecord('airtime',{network,phone,amount:total,baseAmount:amount,fee:CHARGE,description,api_ref:r.ref});
  var p=$('vtu2AirtimePhone'); if(p)p.value='';
  V2.selectedAirtimeAmt=0;
  qsa('#vtu2Airtime .amtChip').forEach(function(c){c.classList.remove('active');});
  var ai=$('vtu2AirtimeAmt'); if(ai)ai.value='';
  var s=$('vtu2AirtimeSummary'); if(s)s.style.display='none';
}

/* ══════════════════════════════════════════════════════════════════
   6. DATA — reuses the shared catalog helpers already defined in
   the main script (getDataBundles/parseSizeToMB/classifyDuration/
   classifyDataCategory/formatSizeDisplay) against the shared,
   already-cached `vtuCatalog`.
   ══════════════════════════════════════════════════════════════════ */
function selectDataNetwork(net,el){
  V2.dataNetwork=net;
  qsa('#vtu2Data .netBtn').forEach(function(b){b.classList.remove('active');});
  if(el)el.classList.add('active');
  V2.selectedPlan=null;
  renderDataPlans();
}
function selectDuration(dur,el){
  V2.duration=dur;
  qsa('#vtu2DurTabs .chip').forEach(function(c){c.classList.remove('active');});
  if(el)el.classList.add('active');
  V2.selectedPlan=null;
  var s=$('vtu2DataSummary'); if(s)s.style.display='none';
  renderDataPlans();
}
function selectCategory(cat,el){
  V2.category=cat;
  qsa('#vtu2CatTabs .chip').forEach(function(c){c.classList.remove('active');});
  if(el)el.classList.add('active');
  V2.selectedPlan=null;
  var s=$('vtu2DataSummary'); if(s)s.style.display='none';
  renderDataPlans();
}
function renderDataPlans(){
  var el=$('vtu2DataPlansGrid'); if(!el)return;
  if(!vtuCatalog){el.innerHTML='<p class="empty" style="grid-column:1/-1">Loading plans...</p>';return;}
  var all=getDataBundles(vtuCatalog,V2.dataNetwork.toUpperCase());
  var plans=all.filter(function(p){
    var size=p.size||p.bundle||p.label||p.name||'';
    var mb=parseSizeToMB(size);
    var price=+(p.price||p.amount||0);
    return (mb===null||mb>=75)&&price>=50&&classifyDuration(p)===V2.duration
      &&classifyDataCategory(p._bucketKey,p)===V2.category;
  });
  var seen={};
  plans=plans.filter(function(p){
    var key=(p.size||p.bundle||p.label||p.name||'')+'|'+(+(p.price||p.amount||0));
    if(seen[key])return false;seen[key]=true;return true;
  });
  plans.sort(function(a,b){
    var aM=parseSizeToMB(a.size||a.bundle||a.label||a.name||'')||0;
    var bM=parseSizeToMB(b.size||b.bundle||b.label||b.name||'')||0;
    return aM!==bM?aM-bM:(+(a.price||a.amount||0))-(+(b.price||b.amount||0));
  });
  if(!plans.length){
    var durLabel={daily:'daily',weekly:'weekly',monthly:'monthly'}[V2.duration]||'';
    var catLabel={sme:'SME Data',cg:'CG Data',awoof:'Awoof Data',sharing:'Data Sharing',gifting:'Data Gifting',special:'Special Data'}[V2.category]||'';
    el.innerHTML='<p class="empty" style="grid-column:1/-1">No '+durLabel+' '+catLabel+' plans found for '+V2.dataNetwork+'</p>';
    el._plans=[]; return;
  }
  el.innerHTML=plans.map(function(p,i){
    var rawSize=p.size||p.bundle||p.label||p.name||'Plan';
    var sp=formatSizeDisplay(rawSize);
    var planType=p.plan_type||p.type||p.category||'';
    var validity=p.validity||p.duration||p.period||'';
    var rawPrice=+(p.price||p.amount||0);
    var displayPrice=rawPrice+10;
    var sizeHtml=sp.raw?'<div class="planSzRow"><span class="planSzNum">'+sp.raw+'</span></div>':
      '<div class="planSzRow"><span class="planSzNum">'+sp.num+'</span><span class="planSzUnit">'+sp.unit+'</span></div>';
    return '<div class="planCard" onclick="Vtu2.selectDataPlan('+i+',this)">'+
      sizeHtml+(planType?'<span class="planBadge">'+planType+'</span>':'')+
      (validity?'<div class="planValidity">'+validity+'</div>':'')+
      '<div class="planPrice">₦'+displayPrice.toLocaleString()+'</div></div>';
  }).join('');
  el._plans=plans; V2.selectedPlan=null;
  var s=$('vtu2DataSummary'); if(s)s.style.display='none';
}
function selectDataPlan(idx,el){
  var grid=$('vtu2DataPlansGrid');
  var plans=(grid&&grid._plans)||[];
  V2.selectedPlan=plans[idx];
  qsa('#vtu2DataPlansGrid .planCard').forEach(function(c){c.classList.remove('active');});
  if(el)el.classList.add('active');
  var s=$('vtu2DataSummary'), t=$('vtu2DataSummaryText'), a=$('vtu2DataSummaryAmt');
  if(V2.selectedPlan&&s){
    var size=V2.selectedPlan.size||V2.selectedPlan.bundle||V2.selectedPlan.label||'Plan';
    var price=+(V2.selectedPlan.price||V2.selectedPlan.amount||0);
    s.style.display='flex';
    if(t)t.textContent=V2.dataNetwork+' '+size+' (incl. ₦10 charge)';
    if(a)a.textContent='₦'+(price+10).toLocaleString();
  }
}
function confirmData(){
  var phone=($('vtu2DataPhone')||{}).value||'';
  if(!phone||phone.length<11){toast('Enter a valid 11-digit phone number');return;}
  if(!V2.selectedPlan){toast('Select a data plan');return;}
  var rawPrice=+(V2.selectedPlan.price||V2.selectedPlan.amount||0);
  var amount=rawPrice+10;
  var bundleId=V2.selectedPlan.id||V2.selectedPlan.bundle_id;
  if(!bundleId){toast('Plan information incomplete. Please reselect.');return;}
  if((currentUser.balance||0)<amount){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  var planLabel=V2.selectedPlan.size||V2.selectedPlan.bundle||'Data';
  gatePin(function(){ executeData(phone,amount,bundleId,planLabel,V2.dataNetwork,rawPrice); });
}
async function executeData(phone,amount,bundleId,planLabel,network,rawPrice){
  var btn=qs('#vtu2Data .btn.btnP');
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Buying...';}
  var description=network+' '+planLabel+' → '+phone;
  var debit=await debitForPurchase(amount,'vtu',description);
  if(!debit.success){ if(btn){btn.disabled=false;btn.textContent='Buy Data';} toast(debit.message);return; }
  var r=await callRapidBills('/buy-data/',{bundle_id:bundleId,number:phone,wallet:'main'},'data');
  if(btn){btn.disabled=false;btn.textContent='Buy Data';}
  if(!r.success){ await refundPurchase(amount,debit.clientRef,'Refund — Data purchase failed'); toast('❌ '+r.message+' — you have been refunded'); return; }
  await saveRecord('data',{network,phone,amount,baseAmount:rawPrice,fee:10,plan:planLabel,description,api_ref:r.ref});
  V2.selectedPlan=null;
  qsa('#vtu2DataPlansGrid .planCard').forEach(function(c){c.classList.remove('active');});
  var p=$('vtu2DataPhone'); if(p)p.value='';
  var s=$('vtu2DataSummary'); if(s)s.style.display='none';
}

/* ══════════════════════════════════════════════════════════════════
   7. CABLE
   ══════════════════════════════════════════════════════════════════ */
function selectCable(provider,el){
  V2.cable=provider;
  qsa('#vtu2Cable .cProvBtn').forEach(function(b){b.classList.remove('active');});
  if(el)el.classList.add('active');
  renderCablePlans();
}
function renderCablePlans(){
  var sel=$('vtu2CablePlan'); if(!sel)return;
  if(!vtuCatalog){sel.innerHTML='<option value="">-- Loading... --</option>';return;}
  var keys=Object.keys(vtuCatalog);
  var all=[];
  var prov=V2.cable.toUpperCase();
  keys.filter(function(k){return k.toLowerCase().indexOf('cable')!==-1||k.toLowerCase().indexOf(prov.toLowerCase())!==-1;})
    .forEach(function(k){all=all.concat(vtuCatalog[k]);});
  var plans=all.filter(function(p){
    var name=(p.provider||p.network||p.name||p.label||'').toString().toUpperCase();
    return name.indexOf(prov)!==-1;
  });
  if(!plans.length&&all.length)plans=all;
  var seen={};
  plans=plans.filter(function(p){
    var key=(p.name||p.plan||p.label||'')+'|'+(+(p.price||p.amount||0));
    if(seen[key])return false;seen[key]=true;return true;
  });
  plans.sort(function(a,b){return (+(a.price||a.amount||0))-(+(b.price||b.amount||0));});
  if(!plans.length){sel.innerHTML='<option value="">-- No packages found for '+V2.cable+' --</option>';sel._plans=[];return;}
  sel.innerHTML='<option value="">-- Select Package --</option>'+plans.map(function(p,i){
    var name=p.name||p.plan||p.label||'Package';
    var price=+(p.price||p.amount||0);
    return '<option value="'+i+'">'+name+' — ₦'+(price+10).toLocaleString()+'</option>';
  }).join('');
  sel._plans=plans;
  var s=$('vtu2CableSummary'); if(s)s.style.display='none';
}
function updateCableSummary(){
  var sel=$('vtu2CablePlan');
  var idx=sel?sel.value:'';
  var plans=(sel&&sel._plans)||[];
  var s=$('vtu2CableSummary'), t=$('vtu2CableSummaryText'), a=$('vtu2CableSummaryAmt');
  if(idx!==''&&plans[idx]&&s){
    var plan=plans[idx];
    var name=plan.name||plan.plan||plan.label||'Package';
    var price=+(plan.price||plan.amount||0);
    s.style.display='flex';
    if(t)t.textContent=V2.cable+' '+name+' (incl. ₦10 charge)';
    if(a)a.textContent='₦'+(price+10).toLocaleString();
  }else if(s)s.style.display='none';
}
function confirmCable(){
  var card=($('vtu2CableCard')||{}).value||'';
  var sel=$('vtu2CablePlan');
  var idx=sel?sel.value:'';
  var plans=(sel&&sel._plans)||[];
  if(!card.trim()){toast('Enter your smartcard number');return;}
  if(idx===''||!plans[idx]){toast('Select a package');return;}
  var plan=plans[idx];
  var rawPrice=+(plan.price||plan.amount||0);
  var amount=rawPrice+10;
  var planId=plan.id||plan.plan_id;
  if(!planId){toast('Package info incomplete. Please reselect.');return;}
  if((currentUser.balance||0)<amount){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  var planName=plan.name||plan.label||'Package';
  gatePin(function(){ executeCable(card,amount,planId,planName,V2.cable,rawPrice); });
}
async function executeCable(card,amount,planId,planName,provider,rawPrice){
  var btn=qs('#vtu2Cable .btn.btnP');
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Processing...';}
  var description=provider+' '+planName+' → '+card;
  var debit=await debitForPurchase(amount,'vtu',description);
  if(!debit.success){ if(btn){btn.disabled=false;btn.textContent='Pay Subscription';} toast(debit.message);return; }
  var r=await callRapidBills('/buy-cable/',{plan_id:planId,card_number:card,wallet:'main'},'cable');
  if(btn){btn.disabled=false;btn.textContent='Pay Subscription';}
  if(!r.success){ await refundPurchase(amount,debit.clientRef,'Refund — Cable subscription failed'); toast('❌ '+r.message+' — you have been refunded'); return; }
  await saveRecord('cable',{provider,card,amount,baseAmount:rawPrice,fee:10,plan:planName,description,api_ref:r.ref});
  var ci=$('vtu2CableCard'); if(ci)ci.value='';
  var sel=$('vtu2CablePlan'); if(sel)sel.value='';
  var s=$('vtu2CableSummary'); if(s)s.style.display='none';
}

/* ══════════════════════════════════════════════════════════════════
   8. ELECTRICITY  (no service charge — matches the existing app's
   actual payElectricity() logic; nothing invented here)
   ══════════════════════════════════════════════════════════════════ */
function selectDisco(val){V2.disco=val;}
function selectMeterType(type,el){
  V2.meterType=type;
  qsa('#vtu2Electricity .meterBtn').forEach(function(b){b.classList.remove('active');});
  if(el)el.classList.add('active');
}
function selectElecAmt(amt,el){
  V2.selectedElecAmt=amt;
  qsa('#vtu2Electricity .amtChip').forEach(function(c){c.classList.remove('active');});
  if(el)el.classList.add('active');
  var i=$('vtu2ElecAmt'); if(i)i.value='';
}
function clearElecChips(){V2.selectedElecAmt=0;qsa('#vtu2Electricity .amtChip').forEach(function(c){c.classList.remove('active');});}
function confirmElectricity(){
  var meter=($('vtu2Meter')||{}).value||'';
  var phone=($('vtu2ElecPhone')||{}).value||'';
  var custom=parseFloat(($('vtu2ElecAmt')||{}).value||0)||0;
  var amount=V2.selectedElecAmt||custom;
  if(!V2.disco){toast('Select an electricity provider');return;}
  if(!meter.trim()){toast('Enter your meter number');return;}
  if(!phone||phone.length<11){toast('Enter a valid phone number');return;}
  if(!amount||amount<500){toast('Minimum amount is ₦500');return;}
  if((currentUser.balance||0)<amount){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  gatePin(function(){ executeElectricity(meter,phone,amount,V2.disco,V2.meterType); });
}
async function executeElectricity(meter,phone,amount,disco,meterType){
  if(!vtuCatalog)await loadVtuCatalog();
  var providerId=vtuCatalog?findProviderId(vtuCatalog,'power',disco):null;
  if(!providerId){toast('Could not find '+disco+' provider. Please try again shortly.');return;}
  var btn=qs('#vtu2Electricity .btn.btnP');
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Buying...';}
  var description=disco+' Electricity ₦'+amount.toLocaleString()+' → '+meter;
  var debit=await debitForPurchase(amount,'vtu',description);
  if(!debit.success){ if(btn){btn.disabled=false;btn.textContent='Buy Token';} toast(debit.message);return; }
  var r=await callRapidBills('/buy-power/',{provider_id:providerId,meter_number:meter,meter_type:meterType,amount,phone_number:phone,wallet:'main'},'electricity');
  if(btn){btn.disabled=false;btn.textContent='Buy Token';}
  if(!r.success){ await refundPurchase(amount,debit.clientRef,'Refund — Electricity purchase failed'); toast('❌ '+r.message+' — you have been refunded'); return; }
  await saveRecord('electricity',{provider:disco,meter,phone,amount,baseAmount:amount,fee:0,token:r.token,description,api_ref:r.ref});
  var mi=$('vtu2Meter'); if(mi)mi.value='';
  V2.selectedElecAmt=0;
  qsa('#vtu2Electricity .amtChip').forEach(function(c){c.classList.remove('active');});
  var ea=$('vtu2ElecAmt'); if(ea)ea.value='';
}

/* ══════════════════════════════════════════════════════════════════
   9. TRANSACTION RECORD + RECEIPT — reuses the SAME vtu_transactions
   / notifications tables and columns the existing VTU page writes
   to, so both pages' history lists show the same data. Only the
   success DISPLAY differs (dedicated page instead of a toast/modal).
   ══════════════════════════════════════════════════════════════════ */
async function saveRecord(type,data){
  if(!currentUser)return;
  var labels={airtime:'Airtime',data:'Data Bundle',cable:'Cable TV',electricity:'Electricity'};
  try{
    var ins=await sb.from('vtu_transactions').insert({
      user_id:currentUser.id,type,description:data.description,
      amount:data.amount||0,network:data.network||data.provider||'',
      phone:data.phone||data.card||data.meter||'',plan:data.plan||'',
      status:'successful',icon:labels[type]||type,
      api_ref:data.api_ref||'',token:data.token||''
    }).select().single();
    var row=ins.data;
    await sb.from('notifications').insert({
      user_id:currentUser.id,
      text:'<strong>'+(labels[type]||type)+' purchase</strong> of ₦'+(data.amount||0).toLocaleString()+' was successful.',
      read:false
    });
    if(typeof loadVtuHistory==='function'){ try{ await loadVtuHistory(); }catch(e){} }
    showReceipt(type,data,row);
  }catch(e){
    console.error('Vtu2.saveRecord:',e.message);
    toast('Purchase went through, but we could not load your receipt. Check your VTU history.');
  }
}
function showReceipt(type,data,row){
  var labels={airtime:'Airtime',data:'Data Bundle',cable:'Cable TV',electricity:'Electricity'};
  var dest=data.phone||data.card||data.meter||'';
  var destLabel=type==='cable'?'Smartcard Number':type==='electricity'?'Meter Number':'Phone Number';
  $('vtu2RxService').textContent=labels[type]||type;
  var netLbl=$('vtu2RxNetworkLbl'); if(netLbl)netLbl.textContent=(type==='electricity')?'Provider':'Network';
  $('vtu2RxNetwork').textContent=data.network||data.provider||'—';
  var destRow=$('vtu2RxDestRow');
  if(dest){ destRow.classList.remove('hidden'); $('vtu2RxDestLbl').textContent=destLabel; $('vtu2RxDest').textContent=dest; }
  else destRow.classList.add('hidden');
  var tokRow=$('vtu2RxTokenRow');
  if(data.token){ tokRow.classList.remove('hidden'); $('vtu2RxToken').textContent=data.token; }
  else tokRow.classList.add('hidden');
  $('vtu2RxAmount').textContent='₦'+(data.baseAmount||0).toLocaleString();
  $('vtu2RxFee').textContent='₦'+(data.fee||0).toLocaleString();
  $('vtu2RxTotal').textContent='₦'+(data.amount||0).toLocaleString();
  $('vtu2RxTxid').textContent=data.api_ref||(row&&row.id)||'—';
  var when=(row&&row.created_at)?new Date(row.created_at):new Date();
  $('vtu2RxDate').textContent=(typeof fmtDate==='function'?fmtDate(when.toISOString()):when.toLocaleDateString())+' at '+(typeof fmtTime==='function'?fmtTime(when.toISOString()):when.toLocaleTimeString());
  $('vtu2RxMsg').textContent='Your '+(labels[type]||type).toLowerCase()+' has been delivered successfully.';
  qsa('.page').forEach(function(p){p.classList.remove('active');});
  var el=$('pgVtu2Receipt'); if(el)el.classList.add('active');
  var tt=$('topbarTitle'); if(tt)tt.textContent='Receipt';
  window.scrollTo(0,0);
}
function doneReceipt(){ if(typeof nav==='function')nav('dashboard'); }

/* ══════════════════════════════════════════════════════════════════
   10. PIN GATE — every purchase funnels through here before the
   actual execute*() function is ever called. The PIN status is
   always re-read from the database (vtu_pin_status RPC) right
   before deciding what to show — never a cached/hardcoded flag.
   ══════════════════════════════════════════════════════════════════ */
async function refreshPinStatus(){
  try{
    var r=await sb.rpc('vtu_pin_status');
    if(!r.error) V2.pinHasPin = !!r.data;
  }catch(e){ console.error('vtu_pin_status:',e.message); }
  updateQaBadge();
  return V2.pinHasPin;
}
function updateQaBadge(){
  var badge=$('qaVtuLock'), label=$('qaVtuLabel');
  if(!badge)return;
  badge.classList.toggle('hidden', V2.pinHasPin!==true);
  if(label)label.textContent = V2.pinHasPin===true ? 'Secure VTU' : 'VTU';
}
// Pick up the PIN status once login completes, so the dashboard badge is
// correct even before the user ever opens the VTU page themselves.
// launchApp()/checkSession() (main script) set `currentUser` asynchronously
// after auth resolves — there's no event to hook, so this polls briefly
// rather than guessing a fixed delay.
(function waitForUserThenCheck(triesLeft){
  if(typeof currentUser!=='undefined'&&currentUser){ refreshPinStatus(); return; }
  if(triesLeft<=0)return;
  setTimeout(function(){ waitForUserThenCheck(triesLeft-1); }, 500);
})(40);
function renderNotice(){
  var n=$('vtu2Notice');
  if(!n)return;
  n.classList.toggle('hidden', V2.pinHasPin!==false);
}
async function gatePin(onVerified){
  V2.pendingAfterPin=onVerified;
  await refreshPinStatus();
  if(V2.pinHasPin===false){
    openNoPinModal();
    return;
  }
  openPinModal();
}
function openNoPinModal(){ var m=$('vtu2NoPinModal'); if(m)m.classList.remove('hidden'); }
function closeNoPinModal(){ var m=$('vtu2NoPinModal'); if(m)m.classList.add('hidden'); }
function goSetPin(){
  closeNoPinModal();
  closePinModal();
  if(typeof nav==='function'){
    nav('settings').then(function(){ setTimeout(openSettingsModal,80); });
  }else{
    openSettingsModal();
  }
}
function openPinModal(){
  var m=$('vtu2PinModal'); if(!m)return;
  qsa('#vtu2PinBoxes .vtu2PinBox').forEach(function(b){b.value='';b.classList.remove('err');});
  var errEl=$('vtu2PinErr'); if(errEl)errEl.textContent='';
  m.classList.remove('hidden');
  setTimeout(function(){ var f=qs('#vtu2PinBoxes .vtu2PinBox'); if(f)f.focus(); },50);
}
function closePinModal(){ var m=$('vtu2PinModal'); if(m)m.classList.add('hidden'); V2.pendingAfterPin=null; }
async function verifyPinAndProceed(){
  var boxes=qsa('#vtu2PinBoxes .vtu2PinBox');
  var pin=boxes.map(function(b){return b.value;}).join('');
  var errEl=$('vtu2PinErr');
  if(pin.length!==4){ if(errEl)errEl.textContent='Enter all 4 digits'; return; }
  var btn=$('vtu2PinConfirmBtn');
  if(btn){btn.disabled=true;btn.textContent='Verifying...';}
  try{
    var r=await sb.rpc('verify_vtu_pin',{p_pin:pin});
    if(btn){btn.disabled=false;btn.textContent='Confirm';}
    var row=r.data;
    if(r.error||!row||!row.success){
      boxes.forEach(function(b){b.classList.add('err');b.value='';});
      if(boxes[0])boxes[0].focus();
      if(row&&row.no_pin){ if(errEl)errEl.textContent=''; closePinModal(); openNoPinModal(); return; }
      if(errEl)errEl.textContent=(row&&row.message)||'Incorrect PIN';
      return;
    }
    var pending=V2.pendingAfterPin;
    closePinModal();
    if(pending)pending();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Confirm';}
    if(errEl)errEl.textContent='Could not verify PIN. Try again.';
  }
}

/* ══════════════════════════════════════════════════════════════════
   11. SETTINGS — VTU Security PIN section
   ══════════════════════════════════════════════════════════════════ */
async function openSettingsModal(){
  var m=$('vtu2SettingsModal'); if(!m)return;
  m.classList.remove('hidden');
  await refreshPinStatus();
  renderSettingsBody();
}
function closeSettingsModal(){ var m=$('vtu2SettingsModal'); if(m)m.classList.add('hidden'); }
function renderSettingsBody(){
  var body=$('vtu2SettingsBody'); if(!body)return;
  if(V2.pinHasPin===false){
    body.innerHTML =
      '<p style="font-size:11.5px;color:var(--text2);text-align:center;line-height:1.5;margin-bottom:16px">You don\'t have a VTU PIN yet. Create one to secure your airtime, data, cable and electricity purchases.</p>'
      +'<button class="vtu2Btn vtu2BtnP" onclick="Vtu2.startCreatePinFlow()">'+svgLock(14)+' Create PIN</button>';
  }else{
    body.innerHTML =
      '<div class="vtu2SettingsStatus">'+svgCheck(18,'#16a34a')+'<div><b>PIN protection enabled</b><span>Used for all VTU purchases</span></div></div>'
      +'<button class="vtu2Btn vtu2BtnP" onclick="Vtu2.toggleChangePin()">'+svgLock(13)+' Change PIN</button>'
      +'<button class="vtu2Btn vtu2BtnO" onclick="Vtu2.startForgotPin(\'settings\')">Forgot PIN?</button>';
  }
}

/* ── First-time PIN creation: gated behind Face Verification ──
   goSetPin() / Create PIN button never shows the PIN form directly —
   it always routes through the separate Face Verification module
   first. If that module isn't loaded for any reason, PIN creation
   still works (it just skips straight to the form) so this never
   becomes a hard dependency that could block a real user. */
function startCreatePinFlow(){
  if(window.FaceVerification && typeof window.FaceVerification.start==='function'){
    window.FaceVerification.start(
      function onVerified(){ renderCreatePinForm(); },
      function onCancelled(){ /* stayed on the intro — nothing to do */ }
    );
  }else{
    renderCreatePinForm();
  }
}
function renderCreatePinForm(){
  var body=$('vtu2SettingsBody'); if(!body)return;
  body.innerHTML =
    '<p class="vtu2PinMsg" style="margin-bottom:2px">Set a 4-digit PIN to secure all VTU purchases.</p>'
    +'<div class="vtu2FieldLabel">New PIN</div>'
    +'<div class="vtu2PinBoxes" id="vtu2SetPinBoxesA">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2FieldLabel">Confirm PIN</div>'
    +'<div class="vtu2PinBoxes" id="vtu2SetPinBoxesB">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2PinErr" id="vtu2SetPinErr"></div>'
    +'<button class="vtu2Btn vtu2BtnP" id="vtu2CreatePinBtn" onclick="Vtu2.submitCreatePin()">Create PIN</button>'
    +'<button class="vtu2Btn vtu2BtnO" onclick="Vtu2.closeSettingsModal()">Close</button>';
  wireBoxGroup('#vtu2SetPinBoxesA'); wireBoxGroup('#vtu2SetPinBoxesB');
  setTimeout(function(){ var f=qs('#vtu2SetPinBoxesA .vtu2PinBox'); if(f)f.focus(); },50);
}
function toggleChangePin(){
  var body=$('vtu2SettingsBody'); if(!body)return;
  body.innerHTML =
    '<div class="vtu2FieldLabel">Current PIN</div>'
    +'<div class="vtu2PinBoxes sm" id="vtu2OldPinBoxes">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2FieldLabel">New PIN</div>'
    +'<div class="vtu2PinBoxes sm" id="vtu2NewPinBoxesA">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2FieldLabel">Confirm PIN</div>'
    +'<div class="vtu2PinBoxes sm" id="vtu2NewPinBoxesB">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2PinErr" id="vtu2ChangePinErr"></div>'
    +'<button class="vtu2Btn vtu2BtnP" id="vtu2ChangePinBtn" onclick="Vtu2.submitChangePin()">Change PIN</button>'
    +'<button class="vtu2Btn vtu2BtnO" onclick="Vtu2.renderSettingsBody()">Close</button>';
  wireBoxGroup('#vtu2OldPinBoxes'); wireBoxGroup('#vtu2NewPinBoxesA'); wireBoxGroup('#vtu2NewPinBoxesB');
  setTimeout(function(){ var f=qs('#vtu2OldPinBoxes .vtu2PinBox'); if(f)f.focus(); },50);
}
async function submitCreatePin(){
  var a=boxGroupValue('#vtu2SetPinBoxesA'), b=boxGroupValue('#vtu2SetPinBoxesB');
  var errEl=$('vtu2SetPinErr'), btn=$('vtu2CreatePinBtn');
  if(!/^[0-9]{4}$/.test(a)){ if(errEl)errEl.textContent='PIN must be exactly 4 digits'; boxGroupErr('#vtu2SetPinBoxesA'); return; }
  if(a!==b){ if(errEl)errEl.textContent='PINs do not match'; boxGroupErr('#vtu2SetPinBoxesB'); return; }
  if(btn){btn.disabled=true;btn.textContent='Creating...';}
  try{
    var r=await sb.rpc('set_vtu_pin',{p_pin:a});
    var row=r.data;
    if(btn){btn.disabled=false;btn.textContent='Create PIN';}
    if(r.error||!row||!row.success){ if(errEl)errEl.textContent=(row&&row.message)||'Could not set PIN'; return; }
    V2.pinHasPin=true;
    renderNotice();
    renderCreatePinSuccess();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Create PIN';}
    if(errEl)errEl.textContent='Something went wrong. Try again.';
  }
}
function renderCreatePinSuccess(){
  var body=$('vtu2SettingsBody'); if(!body)return;
  body.innerHTML =
    '<div class="vtu2SuccessWrap">'
    +'  <div class="vtu2SuccessIconWrap">'+svgCheck(30,'#16a34a')+'</div>'
    +'  <h3>VTU PIN created</h3>'
    +'  <p>Your VTU Security PIN is now active.</p>'
    +'  <button class="vtu2Btn vtu2BtnP" onclick="Vtu2.closeSettingsModal()">Done</button>'
    +'</div>';
  toast('VTU PIN created');
}
async function submitChangePin(){
  var oldPin=boxGroupValue('#vtu2OldPinBoxes');
  var a=boxGroupValue('#vtu2NewPinBoxesA'), b=boxGroupValue('#vtu2NewPinBoxesB');
  var errEl=$('vtu2ChangePinErr'), btn=$('vtu2ChangePinBtn');
  if(!/^[0-9]{4}$/.test(oldPin)){ if(errEl)errEl.textContent='Enter your current 4-digit PIN'; boxGroupErr('#vtu2OldPinBoxes'); return; }
  if(!/^[0-9]{4}$/.test(a)){ if(errEl)errEl.textContent='New PIN must be exactly 4 digits'; boxGroupErr('#vtu2NewPinBoxesA'); return; }
  if(a!==b){ if(errEl)errEl.textContent='New PINs do not match'; boxGroupErr('#vtu2NewPinBoxesB'); return; }
  if(btn){btn.disabled=true;btn.textContent='Updating...';}
  try{
    var r=await sb.rpc('change_vtu_pin',{p_old_pin:oldPin,p_new_pin:a});
    var row=r.data;
    if(btn){btn.disabled=false;btn.textContent='Change PIN';}
    if(r.error||!row||!row.success){ if(errEl)errEl.textContent=(row&&row.message)||'Could not update PIN'; boxGroupErr('#vtu2OldPinBoxes'); return; }
    toast('VTU PIN updated');
    renderSettingsBody();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Change PIN';}
    if(errEl)errEl.textContent='Something went wrong. Try again.';
  }
}

/* ══════════════════════════════════════════════════════════════════
   12. FORGOT PIN — reuses Supabase Auth's own email-OTP mechanism
   (the same authenticated backend, no new auth system). Proving
   ownership of the account's registered email is what authorises
   the reset; the OLD PIN is never needed or shown.
   ══════════════════════════════════════════════════════════════════ */
function startForgotPin(ctx){
  V2.forgotCtx=ctx;
  closePinModal();
  renderForgotStep1();
  var m=$('vtu2ForgotModal'); if(m)m.classList.remove('hidden');
}
function closeForgotModal(){ var m=$('vtu2ForgotModal'); if(m)m.classList.add('hidden'); }
function maskEmail(email){
  var parts=(email||'').split('@');
  if(parts.length!==2)return email||'';
  var name=parts[0];
  var shown=name.slice(0,Math.min(2,name.length));
  return shown+'***@'+parts[1];
}
function renderForgotStep1(){
  var body=$('vtu2ForgotBody'); if(!body)return;
  body.innerHTML =
    '<div class="vtu2ModalHead">'
    +'  <div class="vtu2PinIconWrap">'+svgMail(24)+'</div>'
    +'  <h3>Reset VTU PIN</h3>'
    +'  <p>We\'ll send a 6-digit verification code to your registered email address.</p>'
    +'</div>'
    +'<div class="vtu2EmailCard"><div class="vtu2EmailIcon">'+svgMail(15)+'</div><div><b>Registered email</b><span>'+maskEmail(currentUser&&currentUser.email)+'</span></div></div>'
    +'<div class="vtu2PinErr" id="vtu2ForgotErr"></div>'
    +'<button class="vtu2Btn vtu2BtnP" onclick="Vtu2.sendResetOtp()" id="vtu2SendOtpBtn">Send verification code</button>'
    +'<button class="vtu2Btn vtu2BtnO" onclick="Vtu2.closeForgotModal()">Back</button>';
}
async function sendResetOtp(){
  var btn=$('vtu2SendOtpBtn'); var errEl=$('vtu2ForgotErr');
  if(!currentUser||!currentUser.email){ if(errEl)errEl.textContent='No account email on file'; return; }
  if(btn){btn.disabled=true;btn.textContent='Sending...';}
  try{
    /* Reuses the site's existing recovery-email verification API
       (Supabase Auth's email-OTP mechanism) — the same one used for
       recovery-email / password verification elsewhere on the site.
       No new email system, no new API. */
    var r=await sb.auth.signInWithOtp({email:currentUser.email,options:{shouldCreateUser:false}});
    if(btn){btn.disabled=false;btn.textContent='Send verification code';}
    if(r.error){ if(errEl)errEl.textContent=r.error.message||'Could not send code'; return; }
    renderForgotStep2();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Send verification code';}
    if(errEl)errEl.textContent=e.message||'Could not send code';
  }
}
function renderForgotStep2(){
  var body=$('vtu2ForgotBody'); if(!body)return;
  body.innerHTML =
    '<div class="vtu2ModalHead">'
    +'  <div class="vtu2PinIconWrap">'+svgMail(24)+'</div>'
    +'  <h3>Verify your email</h3>'
    +'  <p>Enter the 6-digit code sent to your registered email address.</p>'
    +'</div>'
    +'<div class="vtu2PinBoxes" id="vtu2OtpBoxes">'
    +[0,1,2,3,4,5].map(function(){return '<input class="vtu2PinBox" type="text" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2PinErr" id="vtu2ForgotErr"></div>'
    +'<button class="vtu2Btn vtu2BtnP" id="vtu2VerifyOtpBtn" onclick="Vtu2.verifyResetOtp()">Verify code</button>'
    +'<button class="vtu2Btn vtu2BtnO" onclick="Vtu2.renderForgotStep1()">Back</button>'
    +'<div class="vtu2ResendRow">Didn\'t receive the code? <a id="vtu2ResendLink" class="disabled" onclick="Vtu2.sendResetOtpResend()">Resend code</a></div>';
  wireBoxGroup('#vtu2OtpBoxes');
  setTimeout(function(){ var f=qs('#vtu2OtpBoxes .vtu2PinBox'); if(f)f.focus(); },50);
  startResendCountdown(45);
}
function pad2(n){ n=''+n; return n.length<2?'0'+n:n; }
function startResendCountdown(seconds){
  var link=$('vtu2ResendLink'); if(!link)return;
  if(V2.resendTimer)clearInterval(V2.resendTimer);
  var remaining=seconds;
  link.classList.add('disabled');
  link.textContent='Resend code ('+pad2(remaining)+'s)';
  V2.resendTimer=setInterval(function(){
    remaining--;
    var l=$('vtu2ResendLink'); if(!l){clearInterval(V2.resendTimer);return;}
    if(remaining<=0){
      clearInterval(V2.resendTimer);
      l.classList.remove('disabled');
      l.textContent='Resend code';
    }else{
      l.textContent='Resend code ('+pad2(remaining)+'s)';
    }
  },1000);
}
async function sendResetOtpResend(){
  var link=$('vtu2ResendLink'); if(link&&link.classList.contains('disabled'))return;
  var errEl=$('vtu2ForgotErr');
  try{
    var r=await sb.auth.signInWithOtp({email:currentUser.email,options:{shouldCreateUser:false}});
    if(r.error){ if(errEl)errEl.textContent=r.error.message||'Could not resend code'; return; }
    toast('Verification code resent');
    startResendCountdown(45);
  }catch(e){ if(errEl)errEl.textContent=e.message||'Could not resend code'; }
}
async function verifyResetOtp(){
  var code=boxGroupValue('#vtu2OtpBoxes');
  var errEl=$('vtu2ForgotErr'); var btn=$('vtu2VerifyOtpBtn');
  if(code.length!==6){ if(errEl)errEl.textContent='Enter the 6-digit code'; return; }
  if(btn){btn.disabled=true;btn.textContent='Verifying...';}
  try{
    var r=await sb.auth.verifyOtp({email:currentUser.email,token:code,type:'email'});
    if(btn){btn.disabled=false;btn.textContent='Verify code';}
    if(r.error){ if(errEl)errEl.textContent=r.error.message||'Invalid or expired code'; boxGroupErr('#vtu2OtpBoxes'); return; }
    if(V2.resendTimer)clearInterval(V2.resendTimer);
    renderForgotStep3();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Verify code';}
    if(errEl)errEl.textContent=e.message||'Invalid or expired code';
  }
}
function renderForgotStep3(){
  var body=$('vtu2ForgotBody'); if(!body)return;
  body.innerHTML =
    '<div class="vtu2ModalHead">'
    +'  <div class="vtu2PinIconWrap">'+svgLock(24)+'</div>'
    +'  <h3>Create New VTU PIN</h3>'
    +'  <p>Set a 4-digit PIN to secure all VTU purchases.</p>'
    +'</div>'
    +'<div class="vtu2FieldLabel">New PIN</div>'
    +'<div class="vtu2PinBoxes" id="vtu2ResetPinBoxesA">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2FieldLabel">Confirm PIN</div>'
    +'<div class="vtu2PinBoxes" id="vtu2ResetPinBoxesB">'
    +[0,1,2,3].map(function(){return '<input class="vtu2PinBox" type="password" inputmode="numeric" maxlength="1"/>';}).join('')
    +'</div>'
    +'<div class="vtu2PinErr" id="vtu2ForgotErr"></div>'
    +'<button class="vtu2Btn vtu2BtnP" id="vtu2ResetPinBtn" onclick="Vtu2.submitResetPin()">Reset PIN</button>';
  wireBoxGroup('#vtu2ResetPinBoxesA'); wireBoxGroup('#vtu2ResetPinBoxesB');
  setTimeout(function(){ var f=qs('#vtu2ResetPinBoxesA .vtu2PinBox'); if(f)f.focus(); },50);
}
async function submitResetPin(){
  var a=boxGroupValue('#vtu2ResetPinBoxesA'), b=boxGroupValue('#vtu2ResetPinBoxesB');
  var errEl=$('vtu2ForgotErr'), btn=$('vtu2ResetPinBtn');
  if(!/^[0-9]{4}$/.test(a)){ if(errEl)errEl.textContent='PIN must be exactly 4 digits'; boxGroupErr('#vtu2ResetPinBoxesA'); return; }
  if(a!==b){ if(errEl)errEl.textContent='PINs do not match'; boxGroupErr('#vtu2ResetPinBoxesB'); return; }
  if(btn){btn.disabled=true;btn.textContent='Resetting...';}
  try{
    var r=await sb.rpc('reset_vtu_pin',{p_new_pin:a});
    var row=r.data;
    if(btn){btn.disabled=false;btn.textContent='Reset PIN';}
    if(r.error||!row||!row.success){ if(errEl)errEl.textContent=(row&&row.message)||'Could not reset PIN'; return; }
    V2.pinHasPin=true;
    renderNotice();
    renderForgotSuccess();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Reset PIN';}
    if(errEl)errEl.textContent='Something went wrong. Try again.';
  }
}
function renderForgotSuccess(){
  var body=$('vtu2ForgotBody'); if(!body)return;
  body.innerHTML =
    '<div class="vtu2SuccessWrap">'
    +'  <div class="vtu2SuccessIconWrap">'+svgCheck(30,'#16a34a')+'</div>'
    +'  <h3>VTU PIN updated successfully</h3>'
    +'  <p>Your new VTU Security PIN is now active.</p>'
    +'  <button class="vtu2Btn vtu2BtnP" id="vtu2ForgotDoneBtn" onclick="Vtu2.finishForgotPin()">Done</button>'
    +'</div>';
  toast('VTU PIN updated successfully');
}
function finishForgotPin(){
  closeForgotModal();
  var ctx=V2.forgotCtx, pending=V2.pendingAfterPin;
  V2.forgotCtx=null; V2.pendingAfterPin=null;
  if(ctx==='purchase'&&pending){
    pending(); // "return to the appropriate VTU flow" — resume the purchase they were making
  }else if(ctx==='settings'){
    openSettingsModal();
  }
}

/* ══════════════════════════════════════════════════════════════════
   13. PUBLIC API
   ══════════════════════════════════════════════════════════════════ */
window.openVtu2 = openVtu2;                 // used by the Quick Actions button
window.Vtu2OpenSettingsPin = openSettingsModal; // used by the Settings card
window.Vtu2 = {
  back:back, switchTab:switchTab,
  selectNetwork:selectNetwork, selectAirtimeAmt:selectAirtimeAmt, clearAirtimeChips:clearAirtimeChips,
  updateAirtimeSummary:updateAirtimeSummary, confirmAirtime:confirmAirtime,
  selectDataNetwork:selectDataNetwork, selectDuration:selectDuration, selectCategory:selectCategory,
  selectDataPlan:selectDataPlan, confirmData:confirmData,
  selectCable:selectCable, updateCableSummary:updateCableSummary, confirmCable:confirmCable,
  selectDisco:selectDisco, selectMeterType:selectMeterType, selectElecAmt:selectElecAmt,
  clearElecChips:clearElecChips, confirmElectricity:confirmElectricity,
  doneReceipt:doneReceipt,
  closePinModal:closePinModal, verifyPinAndProceed:verifyPinAndProceed,
  closeNoPinModal:closeNoPinModal, goSetPin:goSetPin,
  closeSettingsModal:closeSettingsModal, toggleChangePin:toggleChangePin,
  renderSettingsBody:renderSettingsBody, startCreatePinFlow:startCreatePinFlow,
  submitCreatePin:submitCreatePin, submitChangePin:submitChangePin,
  startForgotPin:startForgotPin, closeForgotModal:closeForgotModal,
  renderForgotStep1:renderForgotStep1,
  sendResetOtp:sendResetOtp, sendResetOtpResend:sendResetOtpResend,
  verifyResetOtp:verifyResetOtp, submitResetPin:submitResetPin,
  finishForgotPin:finishForgotPin,
  refreshPinStatus:refreshPinStatus
};

})();
