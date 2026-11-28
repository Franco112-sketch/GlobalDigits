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
// HTML-escape provider/catalog text before it goes into innerHTML (gdEsc lives in index.html).
function esc(s){return (typeof window.gdEsc==='function')?window.gdEsc(s):String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
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
/* Larger PIN sheets (entry / set / settings / forgot) */
+'.mBox.vtu2PinSheet{max-width:460px;width:100%;min-height:58vh;display:flex;flex-direction:column;justify-content:center;border-radius:26px 26px 0 0;padding:34px 24px calc(28px + env(safe-area-inset-bottom,0px));}'
+'.mOverlay:has(.vtu2PinSheet){align-items:flex-end;}'
+'@media (min-width:600px){.mOverlay:has(.vtu2PinSheet){align-items:center;padding:16px;}.mBox.vtu2PinSheet{min-height:0;border-radius:26px;padding:36px 30px 30px;}}'
+'.vtu2PinSheet .vtu2ModalClose{top:16px;right:16px;width:32px;height:32px;}'
+'.vtu2PinSheet .vtu2ModalHead{margin-bottom:22px;}'
+'.vtu2PinSheet .vtu2PinIconWrap{width:76px;height:76px;margin-bottom:16px;}'
+'.vtu2PinSheet .vtu2PinIconWrap svg{width:30px;height:30px;}'
+'.vtu2PinSheet .vtu2ModalHead h3{font-size:19px;margin-bottom:6px;}'
+'.vtu2PinSheet .vtu2ModalHead p{font-size:12.5px;line-height:1.5;padding:0 10px;}'
+'.vtu2PinSheet .vtu2PinBoxes{gap:14px;margin:8px 0 10px;}'
+'.vtu2PinSheet .vtu2PinBox{width:62px;height:70px;font-size:28px;border-radius:16px;}'
+'.vtu2PinSheet .vtu2PinBoxes.sm .vtu2PinBox{width:52px;height:60px;font-size:24px;border-radius:14px;}'
+'.vtu2PinSheet .vtu2PinErr{font-size:12.5px;min-height:20px;margin-bottom:10px;}'
+'.vtu2PinSheet .vtu2Btn{height:54px;font-size:14.5px;border-radius:14px;}'
+'.vtu2PinSheet .vtu2ForgotLink{font-size:13px;margin-top:16px;}'
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
+'.vtu2SuccessIconWrap{width:60px;height:60px;border-radius:50%;background:var(--surface2);color:var(--text);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;}'
+'.vtu2SuccessWrap h3{font-family:var(--font-d);font-size:15.5px;font-weight:600;margin-bottom:5px;}'
+'.vtu2SuccessWrap p{font-size:11.5px;color:var(--text2);margin-bottom:18px;}'
+'.vtu2ReceiptWrap{text-align:center;padding:14px 0 6px;}'
+'.vtu2ReceiptIconWrap{width:92px;height:92px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}'
+'.vtu2ReceiptWrap h2{font-family:var(--font-d);font-size:18px;font-weight:600;margin-bottom:6px;}'
+'.vtu2ReceiptWrap>p{font-size:12.5px;color:var(--text2);margin-bottom:18px;}'
+'.vtu2ReceiptCard{background:var(--surface2);border-radius:14px;padding:4px 14px;text-align:left;margin-bottom:18px;}'
+'.vtu2ReceiptRow{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--border);font-size:12.5px;}'
+'.vtu2ReceiptRow:last-child{border-bottom:none;}'
+'.vtu2ReceiptRow span:first-child{color:var(--text2);}'
+'.vtu2ReceiptRow span:last-child{font-weight:600;text-align:right;}'
+'.vtu2ReceiptRow.tot span:last-child{color:var(--brand);font-family:var(--font-d);font-size:14px;}'
+'.vtu2SettingsStatus{display:flex;align-items:center;gap:9px;background:var(--surface2);border-radius:12px;padding:10px 12px;margin-bottom:14px;}'
+'.vtu2SettingsStatus svg{flex-shrink:0;}'
+'.vtu2SettingsStatus b{font-size:12px;color:var(--text);display:block;}'
+'.vtu2SettingsStatus span{font-size:10.5px;color:var(--text2);}'
+'.vtu2Otp6{display:flex;gap:7px;justify-content:center;margin:16px 0 6px;}'
+'.vtu2Otp6 input{width:38px;height:46px;border:1.5px solid var(--border);border-radius:10px;text-align:center;font-size:17px;font-weight:700;font-family:var(--font-d);outline:none;}'
+'.vtu2Otp6 input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--ring-lt);}';
css += "#pgVtu2 .formCard{padding:12px;border-radius:12px;box-shadow:none}#pgVtu2 .settingsCardHead{margin-bottom:8px}#pgVtu2 .fG{margin-bottom:10px}#pgVtu2 .fG>label{font-size:10.5px;font-weight:600;color:var(--text2);margin-bottom:4px;display:block}#pgVtu2 .fI{border-radius:9px;padding:9px 10px;font-size:12.5px}#pgVtu2 .netGrid{gap:6px}#pgVtu2 .netBtn{padding:7px 4px;border-radius:10px;gap:3px}#pgVtu2 .netBtn span{font-size:10px}#pgVtu2 .netLogo{background:var(--surface2)!important;color:var(--text)!important;border:1px solid var(--border);width:22px;height:22px}#pgVtu2 .netBtn.active,#pgVtu2 .amtChip.active,#pgVtu2 .planCard.active,#pgVtu2 .cProvBtn.active,#pgVtu2 .meterBtn.active{border-color:var(--text);background:var(--surface2);color:var(--text);box-shadow:none}#pgVtu2 .netBtn.active .netLogo{background:var(--text)!important;color:var(--bg)!important;border-color:var(--text)}#pgVtu2 .amtGrid{gap:6px}#pgVtu2 .amtChip{padding:7px 4px;border-radius:9px}#pgVtu2 .planCard{border-radius:10px}#pgVtu2 .planPrice{color:var(--text)}#pgVtu2 .chip.active{background:var(--text);color:var(--bg);border-color:var(--text)}#pgVtu2 .btn.btnP{padding:11px;font-size:13px;border-radius:10px;box-shadow:none}#pgVtu2 .vtuSummary{border-radius:10px;background:var(--surface2);border:1px solid var(--border)}.vtu2BackBtn{background:var(--surface)}.vtu2BtnP{box-shadow:none;color:var(--gd-on-accent)}.vtu2SuccessIconWrap,.vtu2ReceiptIconWrap{background:var(--surface2);color:var(--text)}.vtu2SettingsStatus{background:var(--surface2)}.vtu2SettingsStatus b{color:var(--text)}.vtu2Sv{margin-bottom:10px}.vtu2SvRow{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;font-weight:600;color:var(--text2);margin-bottom:5px}.vtu2SvRow button{font-size:10.5px;font-weight:600;color:var(--text);text-decoration:underline;background:none;border:0;padding:0;cursor:pointer}.vtu2SvChips{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}.vtu2SvChips::-webkit-scrollbar{display:none}.vtu2SvChips em{font-size:10.5px;color:var(--text3);font-style:normal;align-self:center;white-space:nowrap}.vtu2SvChip,.vtu2SvAdd{flex:0 0 auto;border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:6px 10px;text-align:left;cursor:pointer;color:var(--text);transition:border-color .15s,background .15s}.vtu2SvChip b{display:block;font-size:11.5px;font-weight:600;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vtu2SvChip span{display:block;font-size:9.5px;color:var(--text2);margin-top:1px;white-space:nowrap}.vtu2SvChip.on{border-color:var(--text);background:var(--surface2)}.vtu2SvAdd{border-style:dashed;font-size:11px;font-weight:600;color:var(--text2)}.vtu2Hint{font-size:10px;color:var(--text2);margin-top:5px;line-height:1.35}.vtu2Pick{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border:1.5px solid var(--border);border-radius:9px;background:var(--gd-surface,var(--bg));color:var(--text);font-size:12.5px;cursor:pointer;text-align:left}.vtu2Pick span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vtu2Pick .ph{color:var(--text3)}.vtu2Pick svg{flex-shrink:0;color:var(--text2)}.mOverlay:has(.vtu2SheetBox){align-items:flex-end}.mBox.vtu2SheetBox{background:var(--gd-elev,var(--surface));max-width:460px;width:100%;max-height:80vh;overflow-y:auto;border-radius:18px 18px 0 0;padding:8px 14px calc(16px + env(safe-area-inset-bottom,0px));animation:slideUp .2s ease-out}@media (min-width:600px){.mOverlay:has(.vtu2SheetBox){align-items:center;padding:16px}.mBox.vtu2SheetBox{border-radius:18px}}.vtu2Grab{width:34px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 8px}.vtu2ShHead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.vtu2ShHead h3{font-family:var(--font-d);font-size:14px;font-weight:600;margin:0}.vtu2ShX{width:26px;height:26px;border-radius:50%;background:var(--surface2);border:0;color:var(--text2);display:flex;align-items:center;justify-content:center;cursor:pointer}.vtu2Search{margin-bottom:8px}.vtu2List{display:flex;flex-direction:column;max-height:52vh;overflow-y:auto}.vtu2Opt{display:flex;align-items:center;gap:8px;padding:10px 4px;border:0;border-bottom:1px solid var(--border);background:none;color:var(--text);text-align:left;cursor:pointer;font-size:12.5px}.vtu2Opt:last-child{border-bottom:0}.vtu2OptT{flex:1;min-width:0;font-weight:500}.vtu2OptR{font-size:12px;color:var(--text2);font-weight:600;white-space:nowrap}.vtu2Opt.on .vtu2OptT{font-weight:700}.vtu2Empty{font-size:11.5px;color:var(--text3);text-align:center;padding:14px 0}.vtu2MRow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 2px;border-bottom:1px solid var(--border)}.vtu2MRow:last-child{border-bottom:0}.vtu2MTxt{min-width:0}.vtu2MTxt b{display:block;font-size:12.5px;font-weight:600}.vtu2MTxt span{display:block;font-size:10.5px;color:var(--text2);margin-top:1px}.vtu2MAct{display:flex;gap:6px;flex-shrink:0}.vtu2MAct button{font-size:10.5px;font-weight:600;padding:5px 9px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}.vtu2MAct button.warn{background:var(--text);color:var(--bg);border-color:var(--text)}.vtu2DupHead{text-align:center;margin-bottom:12px}.vtu2DupIco{width:38px;height:38px;border-radius:50%;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;margin:2px auto 8px;color:var(--text)}.vtu2DupHead h3{font-family:var(--font-d);font-size:14.5px;font-weight:600;margin:0 0 3px}.vtu2DupHead p{font-size:11px;color:var(--text2);margin:0}.vtu2DupCard{background:var(--surface2);border-radius:12px;padding:2px 12px;margin-bottom:12px}.vtu2DupCard div{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:11.5px}.vtu2DupCard div:last-child{border-bottom:0}.vtu2DupCard span{color:var(--text2)}.vtu2DupCard b{font-weight:600;text-align:right}#vtu2RxSave{margin-bottom:10px}";
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

/* ══════════════════════════════════════════════════════════════════
   UPGRADE MODULE — network detection, Saved Details, duplicate guard,
   bottom-sheet pickers. Needs vtu_saved_and_duplicates.sql run once.
   ══════════════════════════════════════════════════════════════════ */
V2.det={airtime:{last:'',manual:false},data:{last:'',manual:false}};
V2.svActive={}; V2.busy=false; V2.lastOk=false; V2.last=null;
var SV={items:[],loading:false,err:null,q:'',form:null,pick:null,delArm:null,tab:'airtime'};
var NET_PREFIX={
  MTN:['0803','0806','0703','0706','0813','0816','0810','0814','0903','0906','0913','0916','0704','07025','07026'],
  AIRTEL:['0802','0808','0708','0812','0701','0902','0901','0904','0907','0912'],
  GLO:['0805','0807','0705','0815','0811','0905','0915'],
  '9MOBILE':['0809','0818','0817','0909','0908']
};
var NET_LABEL={MTN:'MTN',AIRTEL:'Airtel',GLO:'Glo','9MOBILE':'9mobile'};
var PROV_LABEL={DSTV:'DStv',GOTV:'GOtv',STARTIMES:'StarTimes'};
var CHEV='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>';

/* ── Network detection (prefix based; manual override always wins) ── */
function detectNetwork(raw){
  var n=String(raw||'').replace(/\D/g,''); if(n.length<4)return '';
  var best='',len=0;
  Object.keys(NET_PREFIX).forEach(function(net){NET_PREFIX[net].forEach(function(p){
    if(n.indexOf(p)===0&&p.length>len){best=net;len=p.length;}
  });});
  return best;
}
function phoneInputId(kind){return kind==='airtime'?'vtu2AirtimePhone':'vtu2DataPhone';}
function setNet(kind,net,manual){
  if(kind==='airtime')V2.network=net; else {V2.dataNetwork=net;V2.selectedPlan=null;}
  qsa((kind==='airtime'?'#vtu2Airtime':'#vtu2Data')+' .netBtn').forEach(function(b){b.classList.toggle('active',b.dataset.net===net);});
  V2.det[kind].manual=!!manual;
  if(kind==='data')renderDataPlans(); else updateAirtimeSummary();
  hintNet(kind);
}
function hintNet(kind){
  var el=$(kind==='airtime'?'vtu2AirtimeNetHint':'vtu2DataNetHint'); if(!el)return;
  var d=V2.det[kind], num=($(phoneInputId(kind))||{}).value||'';
  var cur=kind==='airtime'?V2.network:V2.dataNetwork, t;
  if(num.length<4)t='Network is detected as you type.';
  else if(!d.last)t='Network not recognised. Choose one below.';
  else if(d.manual&&cur!==d.last)t='Using '+NET_LABEL[cur]+' (changed by you). Prefix suggests '+NET_LABEL[d.last]+'.';
  else if(d.manual)t=NET_LABEL[cur]+' selected.';
  else t='Detected '+NET_LABEL[d.last]+' from the prefix. Ported number? Tap a network to change it.';
  el.textContent=t;
}
function onPhoneInput(kind){
  var d=V2.det[kind], det=detectNetwork(($(phoneInputId(kind))||{}).value);
  if(det!==d.last){d.last=det;d.manual=false;}
  if(det&&!d.manual&&(kind==='airtime'?V2.network:V2.dataNetwork)!==det)setNet(kind,det,false);
  hintNet(kind);
}

/* ── Bottom sheet + pickers ── */
function sheet(html){var s=$('vtu2Sheet');if(!s)return;$('vtu2SheetBody').innerHTML=html;s.classList.remove('hidden');}
function closeSheet(){var s=$('vtu2Sheet');if(s)s.classList.add('hidden');}
function shHead(title){return '<div class="vtu2ShHead"><h3>'+esc(title)+'</h3><button type="button" class="vtu2ShX" onclick="Vtu2.closeSheet()" aria-label="Close">'+svgX()+'</button></div>';}
function pickRows(o,q){
  q=(q||'').toLowerCase();
  var rows=o.items.filter(function(it){return !q||(it.t+' '+(it.r||'')).toLowerCase().indexOf(q)!==-1;}).map(function(it){
    var on=String(it.v)===String(o.sel);
    return '<button type="button" class="vtu2Opt'+(on?' on':'')+'" onclick="Vtu2.pickDo(\''+String(it.v).replace(/[^\w-]/g,'')+'\')"><span class="vtu2OptT">'+esc(it.t)+'</span>'+(it.r?'<span class="vtu2OptR">'+esc(it.r)+'</span>':'')+(on?svgCheck(14,'currentColor'):'')+'</button>';
  });
  return rows.join('')||'<p class="vtu2Empty">No matches</p>';
}
function openPicker(o){
  SV.pick=o;
  sheet(shHead(o.title)+(o.items.length>8?'<input class="fI vtu2Search" placeholder="Search" oninput="Vtu2.pickFilter(this.value)"/>':'')+'<div class="vtu2List" id="vtu2PickList">'+pickRows(o,'')+'</div>');
}
function pickFilter(q){var l=$('vtu2PickList');if(l&&SV.pick)l.innerHTML=pickRows(SV.pick,q);}
function pickDo(v){var o=SV.pick;if(!o)return;closeSheet();o.onPick(v);}
function syncPicks(){
  [['vtu2CablePlan','vtu2CablePick','Select package'],['vtu2Disco','vtu2DiscoPick','Select provider']].forEach(function(a){
    var s=$(a[0]),b=$(a[1]); if(!s||!b)return;
    var o=s.selectedIndex>0?s.options[s.selectedIndex]:null;
    b.innerHTML='<span class="'+(o?'':'ph')+'">'+esc(o?o.textContent:a[2])+'</span>'+CHEV;
  });
}
function pickCable(){
  var sel=$('vtu2CablePlan'),plans=(sel&&sel._plans)||[];
  if(!plans.length){toast(vtuCatalog?'No packages found for '+(PROV_LABEL[V2.cable]||V2.cable):'Packages are still loading');return;}
  openPicker({title:(PROV_LABEL[V2.cable]||V2.cable)+' packages',sel:sel.value,
    items:plans.map(function(p,i){return {v:i,t:planName(p),r:'₦'+(planPrice(p)+CABLE_FEE).toLocaleString()};}),
    onPick:function(v){sel.value=v;updateCableSummary();syncPicks();}});
}
function pickDisco(){
  var sel=$('vtu2Disco'); if(!sel)return;
  var items=[].slice.call(sel.options).filter(function(o){return o.value;}).map(function(o){
    var p=o.textContent.split(' — ');return {v:o.value,t:p[0],r:p[1]||''};});
  openPicker({title:'Electricity provider',sel:sel.value,items:items,onPick:function(v){sel.value=v;selectDisco(v);syncPicks();}});
}

/* ── Cable package names / prices ── */
var CABLE_NAMES={
  DSTV:{6100:'DStv STARTER E36',11100:'DStv SELECT E36',21100:'SPORT E36'},
  GOTV:{4100:'GOTV EASY',6100:'GOTV STARTER',11100:'GOTV SELECT'},
  STARTIMES:{2200:'Nova ANTENNA',4100:'Basic ANTENNA',5200:'Basic DISH',7500:'Classic DISH'}
};
var CABLE_FEE=100; /* Cable TV service charge (₦) */
var _nameWarned=false;
function planName(p){
  var keys=['name','plan','label','package','package_name','plan_name','bouquet','bouquet_name','title','product','product_name'];
  for(var i=0;i<keys.length;i++){var v=p[keys[i]];if(typeof v==='string'&&v.trim())return v.trim();}
  /* Fallback only when the catalog record carries no name. Names copied from the RapidBills
     cable dropdowns (screenshots, 28 Nov 2026); matched on provider + base price. */
  var fb=(CABLE_NAMES[V2.cable]||{})[planPrice(p)];
  if(fb)return fb;
  if(!_nameWarned){_nameWarned=true;console.warn('Vtu2: cable catalog record has no recognised name field. Keys:',Object.keys(p));}
  return 'Package';
}
function planPrice(p){var n=+(p.price||p.amount||0);return isFinite(n)?n:0;}

/* ── Saved Details ── */
function svType(tab){return tab==='cable'?'cable':tab==='electricity'?'electricity':'phone';}
function svFor(type){return SV.items.filter(function(i){return i.service_type===type;});}
function svSub(i){
  if(i.service_type==='phone')return (NET_LABEL[i.provider]||i.provider)+' · '+i.identifier;
  if(i.service_type==='cable')return (PROV_LABEL[i.provider]||i.provider)+' · '+i.identifier;
  return i.provider+' · '+(i.meter_type==='postpaid'?'Postpaid':'Prepaid')+' · '+i.identifier;
}
async function svLoad(){
  if(!currentUser||SV.loading)return; SV.loading=true;
  try{
    var r=await sb.from('vtu_saved_details').select('*').eq('user_id',currentUser.id).order('label',{ascending:true});
    if(r.error){SV.err=r.error.message;SV.items=[];console.warn('Vtu2 saved details:',r.error.message);}
    else{SV.err=null;SV.items=r.data||[];}
  }catch(e){SV.err=e.message;SV.items=[];}
  SV.loading=false; svRender();
}
function svRender(){
  [['airtime','Airtime'],['data','Data'],['cable','Cable'],['electricity','Electricity']].forEach(function(t){
    var box=$('vtu2Sv'+t[1]); if(!box)return;
    var type=svType(t[0]),list=svFor(type);
    var noun=type==='phone'?'numbers':type==='cable'?'smartcards':'meters';
    var chips=list.slice(0,12).map(function(i){
      return '<button type="button" class="vtu2SvChip'+(V2.svActive[t[0]]===i.id?' on':'')+'" onclick="Vtu2.svUse(\''+i.id+'\',\''+t[0]+'\')"><b>'+esc(i.label)+'</b><span>'+esc(svSub(i))+'</span></button>';
    }).join('');
    box.innerHTML='<div class="vtu2SvRow"><span>Saved '+noun+'</span>'+(list.length?'<button type="button" onclick="Vtu2.svManage(\''+t[0]+'\')">'+(list.length>12?'See all':'Manage')+'</button>':'')+'</div>'
      +'<div class="vtu2SvChips">'+(chips||'<em>'+(SV.err?'Saved details unavailable':'Nothing saved yet')+'</em>')+'<button type="button" class="vtu2SvAdd" onclick="Vtu2.svAddFromForm(\''+t[0]+'\')">+ Save</button></div>';
  });
}
function svUse(id,tab){
  var it=SV.items.filter(function(x){return x.id===id;})[0]; if(!it)return;
  V2.svActive[tab]=id;
  if(tab==='airtime'||tab==='data'){
    var inp=$(phoneInputId(tab)); if(inp)inp.value=it.identifier;
    var d=V2.det[tab]; d.last=detectNetwork(it.identifier);
    var net=it.provider||d.last; if(net)setNet(tab,net,net!==d.last); else hintNet(tab);
  }else if(tab==='cable'){
    selectCable(it.provider,qs('#vtu2Cable .cProvBtn[data-prov="'+it.provider+'"]'));
    var c=$('vtu2CableCard'); if(c)c.value=it.identifier;
  }else{
    var ds=$('vtu2Disco'); if(ds)ds.value=it.provider; selectDisco(it.provider);
    selectMeterType(it.meter_type==='postpaid'?2:1,qs('#vtu2Electricity .meterBtn[data-mt="'+(it.meter_type==='postpaid'?2:1)+'"]'));
    var m=$('vtu2Meter'); if(m)m.value=it.identifier;
    if(it.meta&&it.meta.phone){var ph=$('vtu2ElecPhone');if(ph)ph.value=it.meta.phone;}
    syncPicks();
  }
  svRender(); toast('Loaded “'+it.label+'”. Review, then confirm to buy.');
}
function svAddFromForm(tab){
  var type=svType(tab),pre={provider:'',identifier:'',meter_type:'',meta:{}};
  if(type==='phone'){pre.identifier=($(phoneInputId(tab))||{}).value||'';pre.provider=tab==='airtime'?V2.network:V2.dataNetwork;}
  else if(type==='cable'){pre.identifier=($('vtu2CableCard')||{}).value||'';pre.provider=V2.cable;}
  else{pre.identifier=($('vtu2Meter')||{}).value||'';pre.provider=V2.disco;pre.meter_type=V2.meterType===2?'postpaid':'prepaid';
    var ph=($('vtu2ElecPhone')||{}).value;if(ph)pre.meta.phone=ph;}
  svForm(type,pre);
}
function svForm(type,rec){
  var isEdit=!!(rec&&rec.id);
  SV.form={type:type,id:isEdit?rec.id:null,meta:rec&&rec.meta||{}};
  var provOpts=[];
  if(type==='phone')provOpts=Object.keys(NET_LABEL).map(function(k){return [k,NET_LABEL[k]];});
  else if(type==='cable')provOpts=Object.keys(PROV_LABEL).map(function(k){return [k,PROV_LABEL[k]];});
  else{var ds=$('vtu2Disco');provOpts=ds?[].slice.call(ds.options).filter(function(o){return o.value;}).map(function(o){return [o.value,o.textContent.split(' — ')[0]];}):[];}
  var idLabel=type==='phone'?'Phone number':type==='cable'?'Smartcard / IUC number':'Meter number';
  var provLabel=type==='phone'?'Network':'Provider';
  var cur=rec&&rec.provider||'';
  sheet(shHead(isEdit?'Edit details':'Save details')
    +'<div class="fG"><label>Name</label><input id="svfLabel" class="fI" maxlength="40" placeholder="'+(type==='phone'?'e.g. Mum':type==='cable'?'e.g. Home DStv':'e.g. Office meter')+'" value="'+esc(rec&&rec.label||'')+'"/></div>'
    +'<div class="fG"><label>'+idLabel+'</label><input id="svfId" class="fI" inputmode="numeric" maxlength="'+(type==='phone'?11:15)+'" value="'+esc(rec&&rec.identifier||'')+'" oninput="this.value=this.value.replace(/\\D/g,\'\')"/></div>'
    +'<div class="fG"><label>'+provLabel+'</label><select id="svfProv" class="fI"><option value="">Select</option>'+provOpts.map(function(o){return '<option value="'+esc(o[0])+'"'+(o[0]===cur?' selected':'')+'>'+esc(o[1])+'</option>';}).join('')+'</select></div>'
    +(type==='electricity'?'<div class="fG"><label>Meter type</label><select id="svfMt" class="fI"><option value="prepaid"'+(rec&&rec.meter_type==='postpaid'?'':' selected')+'>Prepaid</option><option value="postpaid"'+(rec&&rec.meter_type==='postpaid'?' selected':'')+'>Postpaid</option></select></div>':'')
    +'<button type="button" class="vtu2Btn vtu2BtnP" id="svfSave" onclick="Vtu2.svSubmit()">'+(isEdit?'Save changes':'Save')+'</button>');
}
async function svSubmit(){
  var f=SV.form; if(!f||!currentUser)return;
  var label=($('svfLabel').value||'').trim(),id=($('svfId').value||'').replace(/\s/g,''),prov=$('svfProv').value;
  var mt=f.type==='electricity'?$('svfMt').value:'';
  if(!label){toast('Enter a name');return;}
  if(f.type==='phone'?!/^0[789]\d{9}$/.test(id):!/^\d{8,15}$/.test(id)){toast(f.type==='phone'?'Enter a valid 11-digit phone number':'Enter a valid number');return;}
  if(!prov){toast('Select a '+(f.type==='phone'?'network':'provider'));return;}
  var clash=SV.items.filter(function(x){return x.service_type===f.type&&x.identifier===id&&x.meter_type===mt&&x.id!==f.id;})[0];
  if(clash){toast('Already saved as “'+clash.label+'”');return;}
  var btn=$('svfSave'); if(btn)btn.disabled=true;
  var row={service_type:f.type,label:label,provider:prov,identifier:id,meter_type:mt,meta:f.meta||{},updated_at:new Date().toISOString()};
  var r;
  try{
    r=f.id?await sb.from('vtu_saved_details').update(row).eq('id',f.id).eq('user_id',currentUser.id)
          :await sb.from('vtu_saved_details').insert(Object.assign({user_id:currentUser.id},row));
  }catch(e){r={error:{message:e.message}};}
  if(btn)btn.disabled=false;
  if(r.error){toast(r.error.code==='23505'?'Already saved':'Could not save details');console.warn('Vtu2 save:',r.error.message);return;}
  closeSheet(); toast('Saved'); await svLoad();
  if(SV.manageOpen)svManage(SV.tab);
  var rx=$('vtu2RxSave'); if(rx)rx.classList.add('hidden');
}
function svManage(tab){
  SV.tab=tab; SV.manageOpen=true; SV.delArm=null; SV.q='';
  var type=svType(tab),list=svFor(type);
  sheet(shHead('Saved '+(type==='phone'?'numbers':type==='cable'?'smartcards':'meters'))
    +(list.length>5?'<input class="fI vtu2Search" placeholder="Search by name or number" oninput="Vtu2.svSearch(this.value)"/>':'')
    +'<div class="vtu2List" id="vtu2MList"></div>');
  svManageRows();
}
function svSearch(q){SV.q=(q||'').toLowerCase();svManageRows();}
function svManageRows(){
  var l=$('vtu2MList'); if(!l)return;
  var list=svFor(svType(SV.tab)).filter(function(i){return !SV.q||(i.label+' '+svSub(i)).toLowerCase().indexOf(SV.q)!==-1;});
  l.innerHTML=list.map(function(i){
    var armed=SV.delArm===i.id;
    return '<div class="vtu2MRow"><div class="vtu2MTxt"><b>'+esc(i.label)+'</b><span>'+esc(svSub(i))+'</span></div><div class="vtu2MAct">'
      +'<button type="button" onclick="Vtu2.svEdit(\''+i.id+'\')">Edit</button>'
      +'<button type="button" class="'+(armed?'warn':'')+'" onclick="Vtu2.svDel(\''+i.id+'\')">'+(armed?'Confirm':'Delete')+'</button></div></div>';
  }).join('')||'<p class="vtu2Empty">'+(SV.q?'No matches':'Nothing saved yet')+'</p>';
}
function svEdit(id){var it=SV.items.filter(function(x){return x.id===id;})[0];if(it){SV.manageOpen=true;svForm(it.service_type,it);}}
async function svDel(id){
  if(SV.delArm!==id){SV.delArm=id;svManageRows();return;}
  SV.delArm=null;
  try{var r=await sb.from('vtu_saved_details').delete().eq('id',id).eq('user_id',currentUser.id);if(r.error)throw r.error;}
  catch(e){toast('Could not delete');return;}
  Object.keys(V2.svActive).forEach(function(k){if(V2.svActive[k]===id)delete V2.svActive[k];});
  await svLoad(); svManageRows();
}
function svSaveFromReceipt(){
  var L=V2.last; if(!L)return; var d=L.data;
  if(L.type==='airtime'||L.type==='data')svForm('phone',{provider:d.network,identifier:d.phone,meter_type:'',meta:{}});
  else if(L.type==='cable')svForm('cable',{provider:d.provider,identifier:d.card,meter_type:'',meta:{}});
  else svForm('electricity',{provider:d.provider,identifier:d.meter,meter_type:d.meterType||'prepaid',meta:d.phone?{phone:d.phone}:{}});
  SV.manageOpen=false;
}
function receiptSaveRow(type,data){
  var rx=$('vtu2RxSave'); if(!rx)return;
  var id=data.phone||data.card||data.meter||'', st=svType(type);
  var exists=SV.items.some(function(x){return x.service_type===st&&x.identifier===id;});
  rx.classList.toggle('hidden',exists||!id);
}

/* ── Duplicate guard (server side: vtu_begin_attempt / vtu_finish_attempt) ── */
async function beginAttempt(key,fp,force){
  try{
    var r=await sb.rpc('vtu_begin_attempt',{p_key:key,p_type:fp.type,p_recipient:fp.recipient,p_provider:fp.provider,p_plan:fp.plan||'',p_plan_label:fp.planLabel||'',p_amount:fp.amount||0,p_meter_type:fp.meterType||'',p_force:!!force});
    if(r.error||!r.data){console.warn('Vtu2 duplicate check unavailable:',r.error&&r.error.message);return {ok:true,unchecked:true};}
    return r.data;
  }catch(e){console.warn('Vtu2 duplicate check unavailable:',e.message);return {ok:true,unchecked:true};}
}
function finishAttempt(key,status){try{sb.rpc('vtu_finish_attempt',{p_key:key,p_status:status}).then(function(){},function(){});}catch(e){}}
async function runAttempt(key,exec){
  V2.lastOk=false; var status='failed';
  try{await exec();status=V2.lastOk?'successful':'failed';}
  catch(e){console.error('Vtu2 purchase error:',e);}
  finally{finishAttempt(key,status);V2.busy=false;}
}
async function startPurchase(fp,exec){
  if(V2.busy)return; V2.busy=true;
  var key=generateUUID(), res=await beginAttempt(key,fp,false);
  if(res.duplicate){V2.busy=false;showDup(fp,res.previous||{},exec);return;}
  if(!res.ok){V2.busy=false;toast(res.message||'Could not start this purchase');return;}
  await runAttempt(key,exec);
}
function ago(iso){
  var s=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/1000));
  return s<5?'just now':s<60?s+' seconds ago':Math.round(s/60)+' minute ago';
}
function showDup(fp,prev,exec){
  var svcName={airtime:'Airtime',data:'Data',cable:'Cable TV',electricity:'Electricity'}[fp.type];
  var provName=NET_LABEL[fp.provider]||PROV_LABEL[fp.provider]||fp.provider;
  var st={processing:'Processing',pending:'Pending',successful:'Successful',failed:'Failed'}[prev.status]||prev.status||'—';
  var what=fp.type==='airtime'||fp.type==='electricity'?'₦'+(+(fp.baseAmount||fp.amount)).toLocaleString():(fp.planLabel||'—');
  SV.dup={fp:fp,exec:exec};
  sheet('<div class="vtu2DupHead"><div class="vtu2DupIco"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>'
    +'<h3>Possible Duplicate Transaction</h3><p>You recently attempted a similar transaction for this recipient.</p></div>'
    +'<div class="vtu2DupCard">'
    +'<div><span>Service</span><b>'+esc(svcName)+'</b></div>'
    +'<div><span>'+(fp.type==='cable'?'Smartcard':fp.type==='electricity'?'Meter':'Number')+'</span><b>'+esc(fp.recipient)+'</b></div>'
    +'<div><span>'+(fp.type==='electricity'?'Provider':fp.type==='cable'?'Provider':'Network')+'</span><b>'+esc(provName)+(fp.meterType?' · '+esc(fp.meterType==='postpaid'?'Postpaid':'Prepaid'):'')+'</b></div>'
    +'<div><span>'+(fp.type==='airtime'||fp.type==='electricity'?'Amount':'Package')+'</span><b>'+esc(what)+'</b></div>'
    +'<div><span>Previous attempt</span><b>'+(prev.created_at?esc(ago(prev.created_at)):'—')+'</b></div>'
    +'<div><span>Status</span><b>'+esc(st)+'</b></div></div>'
    +'<button type="button" class="vtu2Btn vtu2BtnO" onclick="Vtu2.dupCancel()">Cancel Transaction</button>'
    +'<button type="button" class="vtu2Btn vtu2BtnP" id="vtu2DupGo" onclick="Vtu2.dupContinue()">Continue Purchase</button>');
}
function dupCancel(){SV.dup=null;closeSheet();toast('Transaction cancelled');}
async function dupContinue(){
  var d=SV.dup; if(!d||V2.busy)return; V2.busy=true; SV.dup=null; closeSheet();
  var key=generateUUID(), res=await beginAttempt(key,d.fp,true);
  if(!res.ok){V2.busy=false;toast(res.message||'A matching purchase is still processing. Please wait a moment.');return;}
  await runAttempt(key,d.exec);
}

/* ── Markup enhancements (run once after the page HTML is injected) ── */
function enhanceMarkup(){
  qsa('#pgVtu2 .netBtn').forEach(function(b){var m=/'(\w+)'/.exec(b.getAttribute('onclick')||'');if(m)b.dataset.net=m[1];});
  qsa('#vtu2Cable .cProvBtn').forEach(function(b){var m=/'(\w+)'/.exec(b.getAttribute('onclick')||'');if(m)b.dataset.prov=m[1];});
  qsa('#vtu2Electricity .meterBtn').forEach(function(b){var m=/\((\d)/.exec(b.getAttribute('onclick')||'');if(m)b.dataset.mt=m[1];});
  ['Airtime','Data','Cable','Electricity'].forEach(function(x){
    var h=qs('#vtu2'+x+' .settingsCardHead'); if(h)h.insertAdjacentHTML('afterend','<div class="vtu2Sv" id="vtu2Sv'+x+'"></div>');
  });
  ['airtime','data'].forEach(function(k){
    var inp=$(phoneInputId(k)); if(!inp)return;
    inp.insertAdjacentHTML('afterend','<div class="vtu2Hint" id="vtu2'+(k==='airtime'?'Airtime':'Data')+'NetHint">Network is detected as you type.</div>');
    inp.addEventListener('input',function(){onPhoneInput(k);});
  });
  var cs=$('vtu2CablePlan'); if(cs){cs.style.display='none';cs.insertAdjacentHTML('beforebegin','<button type="button" id="vtu2CablePick" class="vtu2Pick" onclick="Vtu2.pickCable()"></button>');}
  var dsel=$('vtu2Disco'); if(dsel){dsel.style.display='none';dsel.insertAdjacentHTML('beforebegin','<button type="button" id="vtu2DiscoPick" class="vtu2Pick" onclick="Vtu2.pickDisco()"></button>');}
  syncPicks(); svRender();
  document.body.insertAdjacentHTML('beforeend','<div id="vtu2Sheet" class="mOverlay hidden" onclick="if(event.target===this)Vtu2.closeSheet()"><div class="mBox vtu2SheetBox"><div class="vtu2Grab"></div><div id="vtu2SheetBody"></div></div></div>');
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
+'    <div class="vtu2ReceiptIconWrap">'+svgCheck(46,'currentColor')+'</div>'
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
+'    <div id="vtu2RxSave" class="hidden"><button class="vtu2Btn vtu2BtnO" onclick="Vtu2.svSaveFromReceipt()">Save these details</button></div>'
+'    <button class="btn btnP" style="width:100%" onclick="Vtu2.doneReceipt()">Done</button>'
+'  </div>'
+'</div>';

var modalsHtml =
/* PIN entry modal — shown before any purchase completes, when a PIN already exists */
'<div id="vtu2PinModal" class="mOverlay hidden" onclick="if(event.target===this)Vtu2.closePinModal()">'
+'  <div class="mBox vtu2PinSheet" style="position:relative">'
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
+'  <div class="mBox vtu2PinSheet" style="position:relative">'
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
+'  <div class="mBox vtu2PinSheet" style="position:relative">'
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
+'  <div class="mBox vtu2PinSheet" style="position:relative">'
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
  enhanceMarkup();
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
  svLoad();
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
  V2.det.airtime.manual=true; setTimeout(function(){hintNet('airtime');},0);
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
  if(!/^0[789]\d{9}$/.test(phone)){toast('Enter a valid 11-digit phone number');return;}
  if(!amount||amount<100){toast('Minimum airtime is ₦100');return;}
  var total=amount+10;
  if((currentUser.balance||0)<total){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  var net=V2.network; gatePin(function(){ startPurchase({type:'airtime',recipient:phone,provider:net,plan:'',planLabel:'',amount:total,baseAmount:amount,meterType:''},function(){return executeAirtime(phone,amount,net);}); });
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
  if(!r.success){ var rf=await refundPurchase(total,debit.clientRef,'Refund — Airtime purchase failed'); toast('❌ '+r.message+(rf?' — you have been refunded':' — your refund is pending, please contact support')); return; }
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
  V2.det.data.manual=true; setTimeout(function(){hintNet('data');},0);
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
    var sizeHtml=sp.raw?'<div class="planSzRow"><span class="planSzNum">'+esc(sp.raw)+'</span></div>':
      '<div class="planSzRow"><span class="planSzNum">'+esc(sp.num)+'</span><span class="planSzUnit">'+esc(sp.unit)+'</span></div>';
    return '<div class="planCard" onclick="Vtu2.selectDataPlan('+i+',this)">'+
      sizeHtml+(planType?'<span class="planBadge">'+esc(planType)+'</span>':'')+
      (validity?'<div class="planValidity">'+esc(validity)+'</div>':'')+
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
  if(!/^0[789]\d{9}$/.test(phone)){toast('Enter a valid 11-digit phone number');return;}
  if(!V2.selectedPlan){toast('Select a data plan');return;}
  var rawPrice=+(V2.selectedPlan.price||V2.selectedPlan.amount||0);
  var amount=rawPrice+10;
  var bundleId=V2.selectedPlan.id||V2.selectedPlan.bundle_id;
  if(!bundleId){toast('Plan information incomplete. Please reselect.');return;}
  if((currentUser.balance||0)<amount){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  var planLabel=V2.selectedPlan.size||V2.selectedPlan.bundle||'Data';
  var net=V2.dataNetwork; gatePin(function(){ startPurchase({type:'data',recipient:phone,provider:net,plan:String(bundleId),planLabel:planLabel,amount:amount,meterType:''},function(){return executeData(phone,amount,bundleId,planLabel,net,rawPrice);}); });
}
async function executeData(phone,amount,bundleId,planLabel,network,rawPrice){
  var btn=qs('#vtu2Data .btn.btnP');
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Buying...';}
  var description=network+' '+planLabel+' → '+phone;
  var debit=await debitForPurchase(amount,'vtu',description);
  if(!debit.success){ if(btn){btn.disabled=false;btn.textContent='Buy Data';} toast(debit.message);return; }
  var r=await callRapidBills('/buy-data/',{bundle_id:bundleId,number:phone,wallet:'main'},'data');
  if(btn){btn.disabled=false;btn.textContent='Buy Data';}
  if(!r.success){ var rf=await refundPurchase(amount,debit.clientRef,'Refund — Data purchase failed'); toast('❌ '+r.message+(rf?' — you have been refunded':' — your refund is pending, please contact support')); return; }
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
  if(!vtuCatalog){sel.innerHTML='<option value="">-- Loading... --</option>';sel._plans=[];syncPicks();return;}
  var keys=Object.keys(vtuCatalog), all=[], prov=V2.cable.toUpperCase();
  keys.filter(function(k){return k.toLowerCase().indexOf('cable')!==-1||k.toLowerCase().indexOf(prov.toLowerCase())!==-1;})
    .forEach(function(k){all=all.concat(vtuCatalog[k]);});
  var plans=all.filter(function(p){
    var name=(p.provider||p.network||p.name||p.label||'').toString().toUpperCase();
    return name.indexOf(prov)!==-1;
  });
  if(!plans.length&&all.length)plans=all;
  var seen={};
  plans=plans.filter(function(p){
    if(planPrice(p)<=0)return false; /* zero-price catalog rows were rendering as the bogus ₦10 entry */
    var key=planName(p)+'|'+planPrice(p);
    if(seen[key])return false;seen[key]=true;return true;
  });
  plans.sort(function(a,b){return planPrice(a)-planPrice(b);});
  if(!plans.length){sel.innerHTML='<option value="">-- No packages found for '+V2.cable+' --</option>';sel._plans=[];syncPicks();return;}
  sel.innerHTML='<option value="">-- Select Package --</option>'+plans.map(function(p,i){
    return '<option value="'+i+'">'+esc(planName(p))+' — ₦'+(planPrice(p)+CABLE_FEE).toLocaleString()+'</option>';
  }).join('');
  sel._plans=plans; syncPicks();
  var s=$('vtu2CableSummary'); if(s)s.style.display='none';
}
function updateCableSummary(){
  var sel=$('vtu2CablePlan'), idx=sel?sel.value:'', plans=(sel&&sel._plans)||[];
  var s=$('vtu2CableSummary'), t=$('vtu2CableSummaryText'), a=$('vtu2CableSummaryAmt');
  if(idx!==''&&plans[idx]&&s){
    var plan=plans[idx];
    s.style.display='flex';
    if(t)t.textContent=(PROV_LABEL[V2.cable]||V2.cable)+' '+planName(plan)+' (incl. ₦'+CABLE_FEE+' charge)';
    if(a)a.textContent='₦'+(planPrice(plan)+CABLE_FEE).toLocaleString();
  }else if(s)s.style.display='none';
  syncPicks();
}
function confirmCable(){
  var card=($('vtu2CableCard')||{}).value||'';
  var sel=$('vtu2CablePlan');
  var idx=sel?sel.value:'';
  var plans=(sel&&sel._plans)||[];
  if(!card.trim()){toast('Enter your smartcard number');return;}
  if(idx===''||!plans[idx]){toast('Select a package');return;}
  var plan=plans[idx];
  var rawPrice=planPrice(plan);
  var amount=rawPrice+CABLE_FEE;
  var planId=plan.id||plan.plan_id;
  if(!planId){toast('Package info incomplete. Please reselect.');return;}
  if((currentUser.balance||0)<amount){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  var planName=planName(plan);
  var prov=V2.cable; gatePin(function(){ startPurchase({type:'cable',recipient:card.trim(),provider:prov,plan:String(planId),planLabel:planName,amount:amount,meterType:''},function(){return executeCable(card,amount,planId,planName,prov,rawPrice);}); });
}
async function executeCable(card,amount,planId,planName,provider,rawPrice){
  var btn=qs('#vtu2Cable .btn.btnP');
  if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Processing...';}
  var description=provider+' '+planName+' → '+card;
  var debit=await debitForPurchase(amount,'vtu',description);
  if(!debit.success){ if(btn){btn.disabled=false;btn.textContent='Pay Subscription';} toast(debit.message);return; }
  var r=await callRapidBills('/buy-cable/',{plan_id:planId,card_number:card,wallet:'main'},'cable');
  if(btn){btn.disabled=false;btn.textContent='Pay Subscription';}
  if(!r.success){ var rf=await refundPurchase(amount,debit.clientRef,'Refund — Cable subscription failed'); toast('❌ '+r.message+(rf?' — you have been refunded':' — your refund is pending, please contact support')); return; }
  await saveRecord('cable',{provider,card,amount,baseAmount:rawPrice,fee:CABLE_FEE,plan:planName,description,api_ref:r.ref});
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
  if(!/^\d{11}$/.test(phone)){toast('Enter a valid phone number');return;}
  if(!amount||amount<500){toast('Minimum amount is ₦500');return;}
  if((currentUser.balance||0)<amount){toast('Insufficient balance');if(typeof nav==='function')nav('addfunds');return;}
  var dc=V2.disco,mtp=V2.meterType; gatePin(function(){ startPurchase({type:'electricity',recipient:meter.trim(),provider:dc,plan:'',planLabel:'',amount:amount,baseAmount:amount,meterType:(mtp===2?'postpaid':'prepaid')},function(){return executeElectricity(meter,phone,amount,dc,mtp);}); });
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
  if(!r.success){ var rf=await refundPurchase(amount,debit.clientRef,'Refund — Electricity purchase failed'); toast('❌ '+r.message+(rf?' — you have been refunded':' — your refund is pending, please contact support')); return; }
  await saveRecord('electricity',{provider:disco,meter,phone,meterType:(meterType===2?'postpaid':'prepaid'),plan:(meterType===2?'Postpaid':'Prepaid'),amount,baseAmount:amount,fee:0,token:r.token,description,api_ref:r.ref});
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
  V2.lastOk=true; V2.last={type:type,data:data};
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
    if(ins.error)console.error('Vtu2.saveRecord insert:',ins.error.message);
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
  receiptSaveRow(type,data);
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
      '<div class="vtu2SettingsStatus">'+svgCheck(18,'currentColor')+'<div><b>PIN protection enabled</b><span>Used for all VTU purchases</span></div></div>'
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
    +'  <div class="vtu2SuccessIconWrap">'+svgCheck(30,'currentColor')+'</div>'
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
  var keepPending=V2.pendingAfterPin; // closePinModal() clears it, which made the 'resume purchase' path dead code
  closePinModal();
  V2.pendingAfterPin=keepPending;
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
    +'  <div class="vtu2SuccessIconWrap">'+svgCheck(30,'currentColor')+'</div>'
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
    V2.pendingAfterPin=pending; openPinModal(); // resume the purchase they were making, confirmed with the NEW PIN
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
  refreshPinStatus:refreshPinStatus,
  closeSheet:closeSheet, pickDo:pickDo, pickFilter:pickFilter, pickCable:pickCable, pickDisco:pickDisco,
  svUse:svUse, svAddFromForm:svAddFromForm, svManage:svManage, svSearch:svSearch, svEdit:svEdit, svDel:svDel,
  svSubmit:svSubmit, svSaveFromReceipt:svSaveFromReceipt, dupCancel:dupCancel, dupContinue:dupContinue,
  detectNetwork:detectNetwork
};

})();
