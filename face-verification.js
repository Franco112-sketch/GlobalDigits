/* ══════════════════════════════════════════════════════════════════
   GlobalDigits — FACE VERIFICATION MODULE  (face-verification.js)
   ══════════════════════════════════════════════════════════════════
   Self-contained add-on, independent of vtu-secure.js. It only ever
   exposes one thing to the rest of the app:

     window.FaceVerification.start(onVerified, onCancelled)

   Call it, and it opens a full-screen step (not a bottom-sheet modal,
   so it reads as its own page) that asks the user to look left,
   right, up and down in front of the REAL device camera. If every
   step passes, it shows a short success state and calls
   onVerified(). If the user backs out at any point, it calls
   onCancelled() instead and nothing else in the app is touched.

   WHAT THIS ACTUALLY CHECKS
   ──────────────────────────
   This is a BASIC anti-bot / liveness gate, not a biometric identity
   check. It never identifies who the person is, never compares faces,
   and never stores or uploads any image or video — everything below
   happens locally in the browser and the camera stream is discarded
   the moment this closes. For each prompted direction it simply
   measures how much the live camera frame changes over a short
   window (a grayscale frame-difference heuristic) to confirm a real,
   moving camera feed is in front of the screen rather than a static
   photo or a blocked/fake camera. It does NOT claim high-security
   biometric identity verification.

   WHY THIS VERSION IS STRUCTURED THE WAY IT IS (camera-render fix)
   ──────────────────────────────────────────────────────────────
   The one and only <video> element used to show the live camera feed
   is created ONCE, up front, and stays in the page for the whole
   life of the overlay. It is never recreated and never removed while
   a verification attempt is running. Every previous version of this
   file that rebuilt the video element (or the container around it)
   on every step caused the real camera feed to be silently replaced
   by the placeholder camera icon, which is exactly the bug this
   fixes — the video is real, native getUserMedia() video, never an
   SVG or a hardcoded placeholder image standing in for it.

   This file does not touch vtu-secure.js, does not call any Supabase
   RPC, and does not know anything about PINs — it only runs a camera
   check and reports pass/fail via the two callbacks above.
   ══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

function $(id){return document.getElementById(id);}

/* ══ STATE ══ */
var FV = {
  stream:null,
  video:null,           // the one persistent <video> element, set once in buildOverlay()
  onVerified:null,
  onCancelled:null,
  stepIndex:0,
  attempts:0,
  sampleTimer:null,
  stepTimer:null,
  lastFrame:null,
  motionScore:0
};

var STEPS = [
  {key:'left',  label:'Look Left',  instr:'Please slowly turn your head to the left.'},
  {key:'right', label:'Look Right', instr:'Please slowly turn your head to the right.'},
  {key:'up',    label:'Look Up',    instr:'Please slowly tilt your head up.'},
  {key:'down',  label:'Look Down',  instr:'Please slowly tilt your head down.'}
];
var SAMPLE_WINDOW_MS = 2200;   // how long we watch for movement per step
var SAMPLE_INTERVAL_MS = 120;  // how often we diff frames
var MOTION_THRESHOLD = 10;     // avg per-pixel grayscale delta needed to count as "moved"
var MAX_ATTEMPTS_PER_STEP = 2;

/* ══════════════════════════════════════════════════════════════════
   1. STYLES
   ══════════════════════════════════════════════════════════════════ */
var css = ''
+'#fvOverlay{position:fixed;inset:0;background:var(--surface,#fff);z-index:9500;display:flex;flex-direction:column;font-family:var(--font,"Plus Jakarta Sans",sans-serif);}'
+'#fvOverlay.hidden{display:none;}'
+'.fvHead{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border,#dbe9fd);flex-shrink:0;}'
+'.fvBackBtn{width:32px;height:32px;border-radius:50%;border:1.5px solid var(--border,#dbe9fd);background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;color:var(--text2,#5a6580);}'
+'.fvHead h2{font-family:var(--font-d,inherit);font-size:15px;font-weight:600;margin:0;color:var(--text,#0d1321);}'
+'.fvHead p{font-size:10px;color:var(--text2,#5a6580);margin-top:1px;}'
+'.fvBody{flex:1;overflow-y:auto;position:relative;}'
+'.fvScreen{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 20px 28px;text-align:center;min-height:100%;}'
+'.fvScreen.hidden{display:none;}'
+'.fvFrameWrap{position:relative;width:168px;height:168px;margin:0 auto 18px;flex-shrink:0;}'
+'.fvFrameRing{position:absolute;inset:0;border-radius:50%;border:2.5px solid var(--brand,#1a56db);opacity:.9;transition:border-color .25s ease;pointer-events:none;}'
+'.fvFrameRing.ok{border-color:#16a34a;}'
+'.fvFrameRing.bad{border-color:var(--danger,#ef4444);}'
+'.fvVideoCircle{position:absolute;inset:7px;border-radius:50%;overflow:hidden;background:#0d1321;}'
+'.fvVideoCircle #fvPlaceholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;opacity:.55;}'
+'.fvVideoCircle #fvVideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);background:#0d1321;display:none;}'
+'.fvVideoCircle.live #fvVideo{display:block;}'
+'.fvVideoCircle.live #fvPlaceholder{display:none;}'
+'.fvPulseDot{position:absolute;right:6px;bottom:6px;width:14px;height:14px;border-radius:50%;background:var(--brand,#1a56db);border:2px solid #fff;box-shadow:0 0 0 0 rgba(26,86,219,.5);animation:fvPulse 1.5s infinite;}'
+'@keyframes fvPulse{0%{box-shadow:0 0 0 0 rgba(26,86,219,.45);}70%{box-shadow:0 0 0 9px rgba(26,86,219,0);}100%{box-shadow:0 0 0 0 rgba(26,86,219,0);}}'
+'.fvStepLabel{font-size:9.5px;font-weight:700;color:var(--brand,#1a56db);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;}'
+'.fvHeading{font-family:var(--font-d,inherit);font-size:17px;font-weight:600;color:var(--text,#0d1321);margin-bottom:6px;}'
+'.fvSub{font-size:12px;color:var(--text2,#5a6580);line-height:1.5;max-width:280px;margin:0 auto 18px;}'
+'.fvDirRow{display:flex;gap:10px;justify-content:center;margin-bottom:4px;}'
+'.fvDirBtn{display:flex;flex-direction:column;align-items:center;gap:5px;}'
+'.fvDirIcon{width:38px;height:38px;border-radius:50%;background:var(--surface2,#eef5ff);border:1.5px solid var(--border,#dbe9fd);display:flex;align-items:center;justify-content:center;color:var(--text2,#5a6580);transition:all .2s ease;}'
+'.fvDirIcon.active{background:var(--brand,#1a56db);border-color:var(--brand,#1a56db);color:#fff;}'
+'.fvDirIcon.done{background:#dcfce7;border-color:#16a34a;color:#16a34a;}'
+'.fvDirBtn span{font-size:9px;color:var(--text2,#5a6580);font-weight:500;}'
+'.fvTrustNote{display:flex;align-items:center;gap:8px;background:var(--surface2,#eef5ff);border-radius:12px;padding:10px 13px;margin-top:22px;max-width:300px;text-align:left;}'
+'.fvTrustNote svg{flex-shrink:0;color:var(--brand,#1a56db);}'
+'.fvTrustNote span{font-size:10px;color:var(--text2,#5a6580);line-height:1.4;}'
+'.fvMsg{font-size:11.5px;color:var(--text2,#5a6580);min-height:16px;margin-top:2px;}'
+'.fvMsg.err{color:var(--danger,#ef4444);}'
+'.fvResultIconWrap{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}'
+'.fvResultIconWrap.ok{background:#dcfce7;}'
+'.fvResultIconWrap.bad{background:#fee2e2;}'
+'.fvBtn{width:100%;max-width:280px;height:46px;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;margin-top:18px;font-family:inherit;transition:background .18s ease;}'
+'.fvBtnP{background:var(--brand,#1a56db);color:#fff;}'
+'.fvBtnP:hover{background:var(--brand-dk,#1342b0);}'
+'.fvBtnP:disabled{opacity:.6;cursor:not-allowed;}'
+'.fvBtnO{background:none;border:1.5px solid var(--border,#dbe9fd);color:var(--text2,#5a6580);margin-top:8px;}';
var styleEl = document.createElement('style');
styleEl.id = 'fvStyles';
styleEl.textContent = css;
document.head.appendChild(styleEl);

/* ══════════════════════════════════════════════════════════════════
   2. ICONS
   ══════════════════════════════════════════════════════════════════ */
function svgX(){return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';}
function svgArrow(dir){
  var points={left:'15 18 9 12 15 6',right:'9 18 15 12 9 6',up:'18 15 12 9 6 15',down:'6 9 12 15 18 9'};
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="'+points[dir]+'"/></svg>';
}
function svgCheck(sz,color){return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="'+color+'" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';}
function svgAlert(sz,color){return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="'+color+'" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';}
function svgShield(){return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';}
function svgCamera(){return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>';}

/* ══════════════════════════════════════════════════════════════════
   3. MARKUP — built exactly ONCE (lazily, on the first start() call).
   The <video id="fvVideo"> element below is the single real camera
   element used for the whole life of the page. Nothing after this
   ever calls document.createElement('video') or replaces this
   element's parent's innerHTML — every state change below only
   toggles CSS classes / text content, so the live stream is never
   interrupted by our own re-renders.
   ══════════════════════════════════════════════════════════════════ */
function buildOverlay(){
  if($('fvOverlay'))return;
  var dirRow = STEPS.map(function(s){
    return '<div class="fvDirBtn"><div class="fvDirIcon" data-dir="'+s.key+'">'+svgArrow(s.key)+'</div><span>'+s.label.replace('Look ','')+'</span></div>';
  }).join('');
  var html =
  '<div id="fvOverlay" class="hidden">'
  +'  <div class="fvHead">'
  +'    <button class="fvBackBtn" id="fvBackBtn" aria-label="Back">'+svgX()+'</button>'
  +'    <div><h2>Face Verification</h2><p>Quick check before you create your PIN</p></div>'
  +'  </div>'
  +'  <div class="fvBody">'

  /* ── Step screen (the only screen with the camera in it) ── */
  +'    <div id="fvScreenStep" class="fvScreen">'
  +'      <div class="fvFrameWrap">'
  +'        <div class="fvFrameRing" id="fvRing"></div>'
  +'        <div class="fvVideoCircle" id="fvVideoWrap">'
  +'          <span id="fvPlaceholder">'+svgCamera()+'</span>'
  +'          <video id="fvVideo" autoplay muted playsinline webkit-playsinline="true"></video>'
  +'        </div>'
  +'        <div class="fvPulseDot" id="fvPulseDot"></div>'
  +'      </div>'
  +'      <div class="fvStepLabel" id="fvStepLabel"></div>'
  +'      <div class="fvHeading" id="fvHeading"></div>'
  +'      <div class="fvSub" id="fvSub"></div>'
  +'      <div class="fvDirRow" id="fvDirRow">'+dirRow+'</div>'
  +'      <div class="fvMsg" id="fvMsg"></div>'
  +'      <div class="fvTrustNote">'+svgShield()+'<span>This helps us prevent fraud and keep your account secure.</span></div>'
  +'    </div>'

  /* ── Permission / camera error screen ── */
  +'    <div id="fvScreenError" class="fvScreen hidden">'
  +'      <div class="fvResultIconWrap bad">'+svgAlert(32,'#ef4444')+'</div>'
  +'      <div class="fvHeading">Camera access needed</div>'
  +'      <div class="fvSub" id="fvErrorMsg">Please allow camera access to verify it\'s you.</div>'
  +'      <button class="fvBtn fvBtnP" id="fvErrorRetryBtn">Try Again</button>'
  +'      <button class="fvBtn fvBtnO" id="fvErrorCancelBtn">Back</button>'
  +'    </div>'

  /* ── Success screen ── */
  +'    <div id="fvScreenSuccess" class="fvScreen hidden">'
  +'      <div class="fvResultIconWrap ok">'+svgCheck(34,'#16a34a')+'</div>'
  +'      <div class="fvHeading">Verification successful</div>'
  +'      <div class="fvSub">You\'re verified. You can now create your VTU Security PIN.</div>'
  +'    </div>'

  /* ── Failure screen ── */
  +'    <div id="fvScreenFail" class="fvScreen hidden">'
  +'      <div class="fvResultIconWrap bad">'+svgAlert(32,'#ef4444')+'</div>'
  +'      <div class="fvHeading">Verification failed</div>'
  +'      <div class="fvSub">Please make sure your face is clearly visible and try again.</div>'
  +'      <button class="fvBtn fvBtnP" id="fvFailRetryBtn">Try Again</button>'
  +'      <button class="fvBtn fvBtnO" id="fvFailCancelBtn">Cancel</button>'
  +'    </div>'

  +'  </div>'
  +'</div>';
  document.body.insertAdjacentHTML('beforeend', html);

  FV.video = $('fvVideo');
  $('fvBackBtn').addEventListener('click', function(){ cancelFlow(); });
  $('fvErrorRetryBtn').addEventListener('click', function(){ beginFlow(); });
  $('fvErrorCancelBtn').addEventListener('click', function(){ cancelFlow(); });
  $('fvFailRetryBtn').addEventListener('click', function(){ beginFlow(); });
  $('fvFailCancelBtn').addEventListener('click', function(){ cancelFlow(); });
}

function showScreen(name){
  ['fvScreenStep','fvScreenError','fvScreenSuccess','fvScreenFail'].forEach(function(id){
    var el=$(id); if(el)el.classList.toggle('hidden', id!==name);
  });
}

/* Per-step text/icon refresh — only ever touches text nodes and
   class names, never the video element or its container. */
function updateStepUI(){
  var step=STEPS[FV.stepIndex];
  var stepLabel=$('fvStepLabel'); if(stepLabel)stepLabel.textContent='Step '+(FV.stepIndex+1)+' of '+STEPS.length;
  var heading=$('fvHeading'); if(heading)heading.textContent=step.label;
  var sub=$('fvSub'); if(sub)sub.textContent=step.instr;
  STEPS.forEach(function(s,i){
    var icon=document.querySelector('.fvDirIcon[data-dir="'+s.key+'"]'); if(!icon)return;
    icon.classList.remove('active','done');
    if(i<FV.stepIndex)icon.classList.add('done');
    else if(i===FV.stepIndex)icon.classList.add('active');
    icon.innerHTML = i<FV.stepIndex ? svgCheck(14,'currentColor') : svgArrow(s.key);
  });
  var msg=$('fvMsg'); if(msg){ msg.textContent=''; msg.classList.remove('err'); }
  var ring=$('fvRing'); if(ring){ ring.classList.remove('ok','bad'); }
  var dot=$('fvPulseDot'); if(dot)dot.style.display='';
}

/* ══════════════════════════════════════════════════════════════════
   4. CAMERA — real getUserMedia video, attached to the ONE persistent
   <video> element built above. No canvas/image/SVG ever stands in
   for the live feed; the small canvas below is only an off-screen
   scratch buffer used to measure motion, it is never shown.
   ══════════════════════════════════════════════════════════════════ */
var canvas, ctx;
function ensureCanvas(){
  if(canvas)return;
  canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48; // small on purpose — we only need coarse motion, not detail
  ctx = canvas.getContext('2d', {willReadFrequently:true});
}
function sampleGrayFrame(video){
  if(!video || video.readyState < 2)return null; // HAVE_CURRENT_DATA — no frame decoded yet
  ensureCanvas();
  try{
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var gray = new Uint8ClampedArray(canvas.width*canvas.height);
    for(var i=0, p=0; i<data.length; i+=4, p++){
      gray[p] = (data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114);
    }
    return gray;
  }catch(e){ return null; }
}
function frameDelta(a,b){
  if(!a||!b)return 0;
  var sum=0;
  for(var i=0;i<a.length;i++){ sum += Math.abs(a[i]-b[i]); }
  return sum/a.length;
}

async function openCamera(){
  var video = FV.video; // the persistent element, never recreated
  if(!video) throw new Error('Video element missing');
  var stream = await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:'user', width:{ideal:480}, height:{ideal:480} },
    audio:false
  });
  FV.stream = stream;
  video.srcObject = stream;
  try{ await video.play(); }catch(e){ /* autoplay+muted+playsinline should still start it */ }
  var wrap=$('fvVideoWrap'); if(wrap)wrap.classList.add('live');
  return video;
}
function stopCamera(){
  if(FV.sampleTimer){ clearInterval(FV.sampleTimer); FV.sampleTimer=null; }
  if(FV.stepTimer){ clearTimeout(FV.stepTimer); FV.stepTimer=null; }
  if(FV.stream){
    FV.stream.getTracks().forEach(function(t){ try{t.stop();}catch(e){} });
    FV.stream=null;
  }
  if(FV.video){ try{FV.video.pause();}catch(e){} FV.video.srcObject=null; }
  var wrap=$('fvVideoWrap'); if(wrap)wrap.classList.remove('live');
}

function runStep(){
  if(FV.stepIndex>=STEPS.length){ finishSuccess(); return; }
  updateStepUI();
  FV.motionScore = 0;
  FV.lastFrame = null;
  FV.sampleTimer = setInterval(function(){
    var frame = sampleGrayFrame(FV.video);
    if(FV.lastFrame) FV.motionScore += frameDelta(frame, FV.lastFrame);
    if(frame) FV.lastFrame = frame;
  }, SAMPLE_INTERVAL_MS);
  FV.stepTimer = setTimeout(evaluateStep, SAMPLE_WINDOW_MS);
}
function evaluateStep(){
  if(FV.sampleTimer){ clearInterval(FV.sampleTimer); FV.sampleTimer=null; }
  var samples = Math.max(1, Math.round(SAMPLE_WINDOW_MS/SAMPLE_INTERVAL_MS));
  var avgMotion = FV.motionScore / samples;
  var ring=$('fvRing');
  if(avgMotion >= MOTION_THRESHOLD){
    if(ring)ring.classList.add('ok');
    var dot=$('fvPulseDot'); if(dot)dot.style.display='none';
    FV.attempts = 0;
    FV.stepTimer = setTimeout(function(){
      FV.stepIndex++;
      runStep();
    }, 500);
  }else{
    FV.attempts++;
    if(ring)ring.classList.add('bad');
    if(FV.attempts >= MAX_ATTEMPTS_PER_STEP){
      finishFailure();
    }else{
      var msg=$('fvMsg');
      if(msg){ msg.textContent='We couldn\'t detect movement — please try again.'; msg.classList.add('err'); }
      FV.stepTimer = setTimeout(function(){
        if(ring)ring.classList.remove('bad');
        runStep();
      }, 900);
    }
  }
}

function finishSuccess(){
  stopCamera();
  showScreen('fvScreenSuccess');
  setTimeout(function(){
    closeOverlay();
    var cb=FV.onVerified;
    if(typeof cb==='function')cb();
  }, 1100);
}
function finishFailure(){
  stopCamera();
  showScreen('fvScreenFail');
}

async function beginFlow(){
  FV.stepIndex = 0;
  FV.attempts = 0;
  showScreen('fvScreenStep');
  updateStepUI();
  try{
    await openCamera();
    runStep();
  }catch(e){
    var text;
    if(e && (e.name==='NotAllowedError' || e.name==='PermissionDeniedError')){
      text = 'Camera permission was denied. Please allow camera access in your browser settings and try again.';
    }else if(e && (e.name==='NotFoundError' || e.name==='DevicesNotFoundError')){
      text = 'No camera was found on this device.';
    }else if(location.protocol!=='https:' && location.hostname!=='localhost'){
      text = 'Camera access requires a secure (https) connection.';
    }else{
      text = 'We couldn\'t access your camera. Please check your camera and try again.';
    }
    var em=$('fvErrorMsg'); if(em)em.textContent=text;
    showScreen('fvScreenError');
  }
}

function cancelFlow(){
  stopCamera();
  closeOverlay();
  var cb=FV.onCancelled;
  if(typeof cb==='function')cb();
}
function closeOverlay(){
  var m=$('fvOverlay'); if(m)m.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════
   5. PUBLIC API
   ══════════════════════════════════════════════════════════════════ */
function start(onVerified, onCancelled){
  buildOverlay();
  FV.onVerified = onVerified;
  FV.onCancelled = onCancelled;
  var m=$('fvOverlay'); if(m)m.classList.remove('hidden');
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    var em=$('fvErrorMsg'); if(em)em.textContent='Your browser doesn\'t support camera access. Please try a different browser.';
    showScreen('fvScreenError');
    return;
  }
  beginFlow();
}

window.FaceVerification = { start: start };

})();
