// scripts/security/scan.mjs — runs in GitHub Actions. Read-only and non-destructive:
// static analysis of the repo, `npm audit --package-lock-only`, Gitleaks, and GET/OPTIONS probes against YOUR OWN allow-listed hosts.
// Every check ends as passed / failed / unverified. If a check could not run, it is "unverified" — never "passed".
import fs from 'node:fs'; import path from 'node:path'; import tls from 'node:tls'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd(), ENV = process.env;
const CFG = Object.assign({ publicFunctions: [], probeFunctions: null, rateProbe: [], extraPaths: [] },
  safeJson(path.join(ROOT, 'security/scan-config.json')));
const R = { appvuln: M(), deps: M(), secrets: M(), network: M(), api: M() };
function M() { return { checks: {}, findings: new Map() }; }
function safeJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
const setCheck = (m, id, status, detail = '') => { const c = R[m].checks; if (!c[id] || (c[id].status !== 'failed' && status === 'failed') || c[id].status === 'unverified') c[id] = { id, status, detail }; };
const unverified = (m, ids, why) => ids.forEach(id => setCheck(m, id, 'unverified', why));

/* ---------- masking: no full secret ever leaves this process ---------- */
const mask = s => String(s ?? '')
  .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, 'eyJ…[masked-jwt]')
  .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, '$1_$2_…[masked]')
  .replace(/((?:password|passwd|secret|token|api[_-]?key|key)\s*[:=]\s*['"])([^'"]{4,})(['"])/gi, (_, a, v, c) => a + v.slice(0, 2) + '…[masked]' + c)
  .replace(/\b[A-Za-z0-9_\-+/]{32,}\b/g, m => m.slice(0, 4) + '…' + m.slice(-2) + '[masked]');
function add(m, o) { // dedupe inside a run on module+check+name+component (server dedupes across runs by fingerprint)
  const k = [o.check_id, o.name, o.component].join('|');
  const prev = R[m].findings.get(k);
  if (prev) { prev.evidence = (prev.evidence + '\n' + o.evidence).slice(0, 1800); return; }
  R[m].findings.set(k, { confirmed: false, reference: '', ...o, evidence: mask(o.evidence) });
  setCheck(m, o.check_id, 'failed', 'See findings');
}

/* ---------- repo walk ---------- */
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|scripts\/security)(\/|$)/;
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), rel = path.relative(ROOT, p);
  if (SKIP.test(rel)) continue; if (e.isDirectory()) walk(p); else if (/\.(html?|m?[jt]sx?|sql|toml|json)$/.test(e.name) && fs.statSync(p).size < 3e6) files.push(rel); } })(ROOT);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const clientFiles = files.filter(f => /\.(html?|jsx?|mjs)$/.test(f) && !/supabase\/functions/.test(f));
const fnFiles = files.filter(f => /supabase\/functions\/[^/]+\/index\.[tj]s$/.test(f));
const sqlFiles = files.filter(f => f.endsWith('.sql'));
const fnName = f => f.split('/').slice(-2)[0];
const lines = (txt, re) => { const out = []; txt.split('\n').forEach((l, i) => { if (re(l)) out.push(`L${i + 1}: ${l.trim().slice(0, 140)}`); }); return out; };
const ev = a => a.slice(0, 5).join('\n') + (a.length > 5 ? `\n… +${a.length - 5} more lines` : '');

/* ---------- 1 · APPLICATION VULNERABILITIES (static; "potential" unless proven dynamically) ---------- */
(function appvuln() {
  const A = 'appvuln';
  if (!clientFiles.length && !fnFiles.length && !sqlFiles.length) return unverified(A, ['sqli', 'xss', 'csrf', 'authbypass', 'idor', 'session', 'inputval', 'apiaccess'], 'No source files found in repository');
  const ran = new Set();
  for (const f of clientFiles) { const t = read(f); ran.add('xss'); ran.add('session');
    let h = lines(t, l => /\.innerHTML\s*\+?=|insertAdjacentHTML\(/.test(l) && (/\+|\$\{/.test(l)) && !/rEsc\(|esc\(|escapeHtml|DOMPurify|textContent/.test(l));
    if (h.length) add(A, { check_id: 'xss', name: 'Unescaped dynamic HTML assigned to DOM', severity: 'Medium', component: f, evidence: `${h.length} line(s)\n` + ev(h),
      description: 'innerHTML / insertAdjacentHTML receives concatenated or interpolated data without an escaping helper on the same line. If any part is user-controlled this is stored/reflected XSS.',
      fix: 'Escape every dynamic value (your rEsc helper) or build nodes with textContent. Verify each flagged line manually; multi-line expressions can be false positives.' });
    h = lines(t, l => /\beval\(|new Function\(|document\.write\(/.test(l));
    if (h.length) add(A, { check_id: 'xss', name: 'Dangerous code-execution sink', severity: 'Medium', component: f, evidence: ev(h), description: 'eval/new Function/document.write executes strings as code.', fix: 'Remove the sink or pass only constants.' });
    h = lines(t, l => /(localStorage|sessionStorage)\.setItem\([^)]*(token|jwt|access|refresh|session)/i.test(l) && !/,\s*['"](1|0|true|false)['"]\s*\)/.test(l));
    if (h.length) add(A, { check_id: 'session', name: 'Token written to web storage by application code', severity: 'Low', component: f, evidence: ev(h), description: 'Tokens in localStorage are readable by any XSS payload.', fix: 'Prefer the Supabase client session handling; never copy tokens into custom storage.' });
    h = lines(t, l => /(location|href|url)[^;\n]{0,60}[?&](access_token|token|jwt|refresh_token)=/i.test(l));
    if (h.length) add(A, { check_id: 'session', name: 'Token placed in URL query string', severity: 'Medium', component: f, evidence: ev(h), description: 'URLs leak through history, logs and Referer headers.', fix: 'Send tokens in the Authorization header or POST body.' });
    h = lines(t, l => /document\.cookie\s*=/.test(l) && !/secure/i.test(l));
    if (h.length) add(A, { check_id: 'session', name: 'Cookie set from JavaScript without Secure flag', severity: 'Medium', component: f, evidence: ev(h), description: 'Script-set cookies cannot be HttpOnly and lack Secure/SameSite here.', fix: 'Set cookies server-side with HttpOnly; Secure; SameSite=Lax/Strict.' });
  }
  for (const f of fnFiles) { const t = read(f), n = fnName(f), pub = CFG.publicFunctions.includes(n);
    ['sqli', 'authbypass', 'idor', 'inputval', 'apiaccess', 'csrf'].forEach(x => ran.add(x));
    const hasAuth = /auth\.getUser|getClaims|jwtVerify|verifyJWT|x-[\w-]*signature|timingSafeEqual|crypto\.subtle\.verify|createHmac/i.test(t);
    const svc = /SERVICE_ROLE/.test(t);
    if (!hasAuth && !pub) add(A, { check_id: 'authbypass', name: svc ? 'Service-role Edge Function without visible authentication' : 'Edge Function without visible authentication', severity: svc ? 'Critical' : 'High', component: `supabase/functions/${n}`,
      evidence: 'No auth.getUser / JWT / signature verification found in source' + (svc ? '; uses SERVICE_ROLE key' : ''),
      description: 'Static analysis found no code that identifies the caller. Unless the platform JWT check is enabled (verify_jwt) this endpoint is open; even then JWT verification alone does not prove the caller is the right user or an admin. Dynamic probing (API Security) confirms or clears it.',
      fix: 'Verify the caller with supabase.auth.getUser(token) and check ownership/admin role, or verify a webhook signature. If intentionally public add the function name to security/scan-config.json publicFunctions.' });
    let h = lines(t, l => /\.(or|filter|ilike|like|eq)\(\s*`[^`]*\$\{/.test(l) || /\.(query|unsafe)\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/.test(l));
    if (h.length) add(A, { check_id: 'sqli', name: 'Interpolated value inside query/filter string', severity: 'High', component: f, evidence: ev(h), description: 'Interpolating input into PostgREST filters or raw SQL allows filter/SQL injection.', fix: 'Use parameterised .eq()/.rpc() arguments or prepared statements; never interpolate request data into filter strings.' });
    if (/(body|payload|data|params|input)\??\.(user_id|userId|owner_id|wallet_id|order_id|account_id)/.test(t) && !/user\.id\s*===|===\s*user\.id|\.eq\(\s*['"]user_id['"]\s*,\s*user\.id|auth\.uid\(\)/.test(t))
      add(A, { check_id: 'idor', name: 'Object identifier taken from request without ownership comparison', severity: 'High', component: `supabase/functions/${n}`, evidence: 'Request-supplied user/wallet/order id used; no comparison with the authenticated user id found',
        description: 'Possible IDOR: a caller may be able to act on another account\'s object by changing the id.', fix: 'Derive the user id from the verified token and/or assert the object belongs to it before acting.' });
    if (/req\.json\(\)/.test(t) && !/(zod|z\.object|safeParse|typeof\s+\w+(\.\w+)*\s*[!=]==|Number\.isFinite|isInteger|uuid|\.test\()/i.test(t))
      add(A, { check_id: 'inputval', name: 'Request body used without visible validation', severity: 'Medium', component: `supabase/functions/${n}`, evidence: 'req.json() parsed; no schema/type/range checks found',
        description: 'Missing validation enables type confusion, negative/huge amounts and malformed data reaching payment, wallet or order logic.', fix: 'Validate with a schema (zod) — types, ranges, enums, max lengths — and reject on failure with a generic 400.' });
    if (/(Set-Cookie|cookies\.get|credentials:\s*['"]include)/i.test(t) && !/origin/i.test(t))
      add(A, { check_id: 'csrf', name: 'Cookie-based endpoint without Origin check', severity: 'Medium', component: `supabase/functions/${n}`, evidence: 'Cookies used; no Origin/Referer validation found', description: 'Cookie-authenticated state-changing endpoints need CSRF defences.', fix: 'Validate the Origin header against an allow-list and use SameSite cookies or CSRF tokens.' });
    if (/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/i.test(t) && (svc || hasAuth))
      add(A, { check_id: 'apiaccess', name: 'Authenticated Edge Function allows any origin (CORS *)', severity: 'Medium', component: `supabase/functions/${n}`, evidence: 'Access-Control-Allow-Origin: *', description: 'Any website can call this endpoint from a victim\'s browser if it holds a token.', fix: 'Reflect only your own origins from an allow-list.' });
  }
  for (const f of sqlFiles) { const t = read(f);
    ['sqli', 'idor', 'apiaccess'].forEach(x => ran.add(x));
    for (const chunk of t.split(/create\s+(?:or\s+replace\s+)?function\s+/i).slice(1)) {
      const name = (chunk.match(/^([\w."]+)\s*\(/) || [])[1] || 'unknown';
      if (!/security\s+definer/i.test(chunk)) continue;
      const head = chunk.slice(0, chunk.search(/\)\s*(returns|language)/i) + 1 || 300), body = chunk.slice(0, 6000);
      if (/\b(p_user_id|p_uid|user_id|p_owner|p_wallet_id)\b/i.test(head) && !/auth\.uid\(\)|is_admin\(\)|gsec_is_admin|admin_my_access/i.test(body))
        add(A, { check_id: 'idor', name: 'SECURITY DEFINER function takes an account id from the caller and never checks auth.uid()/admin', severity: 'High', component: `${f} · ${name}`, evidence: `signature: ${name}(${head.replace(/^[^(]*\(/, '').slice(0, 120)}`, description: 'A privileged function bypasses RLS and trusts a caller-supplied account id: any authenticated user may be able to read or change another user\'s data.', fix: 'Use auth.uid() inside the function, or require is_admin(); revoke EXECUTE from PUBLIC/anon.' });
      if (/execute\s+[^;]*\|\|/i.test(body) && !/format\([^)]*%[IL]|quote_(literal|ident)/i.test(body))
        add(A, { check_id: 'sqli', name: 'Dynamic SQL built by concatenation', severity: 'High', component: `${f} · ${name}`, evidence: 'EXECUTE with || concatenation and no format(%I/%L) or quote_*()', description: 'Concatenated dynamic SQL inside a privileged function is injectable.', fix: 'Use format() with %I/%L or EXECUTE … USING parameters.' });
    }
    const g = lines(t, l => /grant\s+execute\s+on\s+function[^;]*\sto\s[^;]*\banon\b/i.test(l));
    if (g.length) add('appvuln', { check_id: 'apiaccess', name: 'Function executable by anonymous role', severity: 'Medium', component: f, evidence: ev(g), description: 'Anonymous callers can invoke these functions through the public REST API.', fix: 'Grant only to authenticated (or service_role) unless intentionally public.' });
  }
  ['sqli', 'xss', 'csrf', 'authbypass', 'idor', 'session', 'inputval', 'apiaccess'].forEach(id => {
    if (!ran.has(id)) return setCheck(A, id, 'unverified', 'No applicable source files for this check');
    setCheck(A, id, 'passed', 'Static rules matched nothing (dynamic cross-account test not run)'); });
})();

/* ---------- 2 · DEPENDENCIES (npm audit, lockfile only; nothing is installed or changed) ---------- */
(function deps() {
  const D = 'deps';
  if (!fs.existsSync(path.join(ROOT, 'package-lock.json'))) return unverified(D, ['npm-audit'], 'No package-lock.json in repository — npm audit cannot run. Commit a lockfile to enable it.');
  const r = spawnSync('npm', ['audit', '--json', '--package-lock-only'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 5e7 });
  let j; try { j = JSON.parse(r.stdout); } catch { return unverified(D, ['npm-audit'], 'npm audit did not return JSON (registry unreachable?)'); }
  if (j.error) return unverified(D, ['npm-audit'], 'npm audit error: ' + (j.error.summary || j.error.code || 'unknown'));
  const lock = safeJson(path.join(ROOT, 'package-lock.json')).packages || {};
  const sev = { critical: 'Critical', high: 'High', moderate: 'Medium', low: 'Low', info: 'Informational' };
  setCheck(D, 'npm-audit', 'passed', 'npm audit reported no vulnerabilities');
  for (const [pkg, v] of Object.entries(j.vulnerabilities || {})) {
    const node = (v.nodes || [])[0], ver = (lock[node] || {}).version || 'unknown';
    const vias = (v.via || []).filter(x => typeof x === 'object'), transitive = !v.isDirect;
    const fix = v.fixAvailable && typeof v.fixAvailable === 'object' ? `Review then run: npm install ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (semver-major — test first)' : ''}` : (v.fixAvailable ? 'Review then run: npm audit fix (manually)' : 'No fix published; consider replacing the package');
    (vias.length ? vias : [{ title: 'Vulnerable via dependency chain', severity: v.severity, url: '', range: v.range }]).forEach(x => add(D, { check_id: 'npm-audit',
      name: `${pkg}: ${x.title || 'vulnerability'}`.slice(0, 190), severity: sev[x.severity || v.severity] || 'Medium', confirmed: true, component: pkg,
      evidence: `package ${pkg}\ninstalled ${ver}\naffected ${x.range || v.range}\n${transitive ? 'transitive dependency' : 'direct dependency'}${x.url ? '\n' + x.url : ''}`,
      description: `Known advisory in ${pkg}${x.name && x.name !== pkg ? ` (via ${x.name})` : ''}. npm audit does not report CVE ids; the GHSA advisory links to its CVE.`,
      fix: fix + '. Nothing is changed automatically.', reference: (String(x.url || '').match(/GHSA-[\w-]+/) || [''])[0] }));
  }
})();

/* ---------- 3 · SECRETS (Gitleaks + decoded service-role JWT detection) ---------- */
(function secrets() {
  const S = 'secrets';
  // Supabase JWTs are decoded locally: role=service_role in any repo file is a confirmed critical leak. anon keys are public by design.
  let scanned = 0;
  for (const f of files) { let t; try { t = read(f); } catch { continue; } scanned++;
    for (const m of t.matchAll(/eyJ[\w-]{10,}\.(eyJ[\w-]{10,})\.[\w-]{10,}/g)) { let c; try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { continue; }
      if (c.role === 'service_role') add(S, { check_id: 'service-role', name: 'Supabase service-role key present in repository file', severity: 'Critical', confirmed: true, component: f,
        evidence: `JWT (masked) with role=service_role, project ref ${c.ref || 'n/a'}`, description: 'The service-role key bypasses all RLS. Anyone who can read this file (or the Git history, or a deployed page) has full database control.',
        fix: 'Rotate the key in Supabase immediately, remove it from the file AND from Git history, and keep it only in Edge Function secrets.' }); } }
  setCheck(S, 'service-role', scanned ? 'passed' : 'unverified', scanned ? `Decoded every JWT in ${scanned} files; none had role=service_role` : 'No files scanned');
  const rep = path.join(ROOT, '.gitleaks-report.json');
  const g = spawnSync('gitleaks', ['detect', '--source', '.', '--report-format', 'json', '--report-path', rep, '--redact', '--no-banner', '--exit-code', '0'], { cwd: ROOT, encoding: 'utf8' });
  if (g.error || g.status !== 0) return setCheck(S, 'gitleaks', 'unverified', 'Gitleaks did not run (' + (g.error ? g.error.code : 'exit ' + g.status) + ')');
  const out = safeJson(rep); fs.rmSync(rep, { force: true });
  setCheck(S, 'gitleaks', 'passed', 'Gitleaks scanned the working tree and full Git history');
  const crit = /service|private[-_ ]key|database|postgres|stripe|secret/i;
  for (const x of Array.isArray(out) ? out : []) add(S, { check_id: 'gitleaks', name: `${x.Description || x.RuleID} (${x.RuleID})`, severity: crit.test(x.RuleID + x.Description) ? 'Critical' : 'High', confirmed: true,
    component: `${x.File}${x.Commit ? ' @ ' + String(x.Commit).slice(0, 8) : ''}`, evidence: `rule ${x.RuleID}\n${x.File}:${x.StartLine}\ncommit ${String(x.Commit || 'working tree').slice(0, 8)} by ${String(x.Email || '').replace(/(.).*@/, '$1***@')}\nsecret: [redacted by scanner]`,
    description: 'Gitleaks matched a credential pattern. The Match/Secret fields are discarded; only location metadata is stored.',
    fix: 'Rotate the credential, remove it from source, and purge it from history (git filter-repo) if it was ever committed.' });
})();

/* ---------- 4 · NETWORK / WEBSITE ---------- */
const ids = { network: ['https', 'tls', 'tls-expiry', 'hsts', 'csp', 'headers', 'cors', 'cookies', 'exposed', 'waf'], api: ['auth', 'ratelimit', 'cors', 'exposure', 'errors'] };
const target = (ENV.SCAN_TARGET || '').replace(/\/$/, ''), supa = (ENV.SCAN_SUPABASE_URL || '').replace(/\/$/, '');
const allowed = new Set((ENV.SCAN_ALLOWED_HOSTS || [target, supa].filter(Boolean).map(u => { try { return new URL(u).host; } catch { return ''; } }).join(',')).split(',').map(s => s.trim()).filter(Boolean));
const okHost = u => { try { return allowed.has(new URL(u).host); } catch { return false; } };
const get = async (u, o = {}) => { if (!okHost(u)) throw new Error('host not allow-listed'); return fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...o }); };
const tlsInfo = host => new Promise(res => { const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => { const c = s.getPeerCertificate(); res({ ok: s.authorized, err: s.authorizationError, exp: c.valid_to, days: Math.floor((new Date(c.valid_to) - Date.now()) / 864e5) }); s.end(); }); s.on('error', e => res({ err: e.message })); s.setTimeout(8000, () => { res({ err: 'timeout' }); s.destroy(); }); });

async function network() {
  const N = 'network', where = target;
  if (!target || !okHost(target)) return unverified(N, ids.network, 'SCAN_TARGET not set or not allow-listed — no external request was made');
  const u = new URL(target);
  if (u.protocol !== 'https:') add(N, { check_id: 'https', name: 'Site is not served over HTTPS', severity: 'High', confirmed: true, component: where, evidence: 'SCAN_TARGET uses ' + u.protocol, description: 'Traffic can be read and modified in transit.', fix: 'Serve the site over HTTPS only.' });
  else {
    const t = await tlsInfo(u.hostname);
    if (t.err && t.ok === undefined) { setCheck(N, 'tls', 'unverified', 'TLS handshake failed: ' + t.err); setCheck(N, 'tls-expiry', 'unverified', 'No certificate read'); }
    else { if (!t.ok) add(N, { check_id: 'tls', name: 'TLS certificate not trusted', severity: 'High', confirmed: true, component: u.host, evidence: String(t.err), description: 'Browsers will warn or block.', fix: 'Install a valid certificate chain.' }); else setCheck(N, 'tls', 'passed', 'Certificate chain trusted');
      if (t.days < 21) add(N, { check_id: 'tls-expiry', name: t.days < 0 ? 'TLS certificate expired' : 'TLS certificate expires soon', severity: t.days < 7 ? 'High' : 'Medium', confirmed: true, component: u.host, evidence: `expires ${t.exp} (${t.days} days)`, description: 'Expired certificates take the site offline for most users.', fix: 'Renew or enable auto-renewal.' }); else setCheck(N, 'tls-expiry', 'passed', `Expires in ${t.days} days`); }
    try { const h = await get('http://' + u.host + '/'); const loc = h.headers.get('location') || '';
      if (h.status >= 300 && h.status < 400 && loc.startsWith('https://')) setCheck(N, 'https', 'passed', 'HTTP redirects to HTTPS'); else add(N, { check_id: 'https', name: 'HTTP does not redirect to HTTPS', severity: 'Medium', confirmed: true, component: 'http://' + u.host, evidence: `status ${h.status}`, description: 'Users typing the bare domain stay on plaintext HTTP.', fix: 'Redirect all HTTP to HTTPS.' }); }
    catch { setCheck(N, 'https', 'unverified', 'Port 80 unreachable or blocked'); }
  }
  let res; try { res = await get(target + '/'); } catch (e) { return unverified(N, ids.network.filter(i => !['tls', 'tls-expiry', 'https'].includes(i)), 'Site unreachable: ' + e.message); }
  const H = n => res.headers.get(n);
  const hsts = H('strict-transport-security');
  if (!hsts || !/max-age=(\d+)/.test(hsts) || +hsts.match(/max-age=(\d+)/)[1] < 15552000) add(N, { check_id: 'hsts', name: hsts ? 'HSTS max-age too short' : 'Missing Strict-Transport-Security header', severity: 'Medium', confirmed: true, component: where, evidence: `Strict-Transport-Security: ${hsts || '(absent)'}`, description: 'Without HSTS browsers may downgrade to HTTP.', fix: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains' }); else setCheck(N, 'hsts', 'passed', hsts);
  const csp = H('content-security-policy');
  if (!csp) add(N, { check_id: 'csp', name: 'Missing Content-Security-Policy', severity: 'Medium', confirmed: true, component: where, evidence: 'Content-Security-Policy: (absent)', description: 'CSP is the main mitigation if an XSS bug exists.', fix: 'Add a CSP; start in Report-Only mode.' });
  else if (/script-src[^;]*'unsafe-inline'|default-src[^;]*\*/.test(csp)) add(N, { check_id: 'csp', name: 'Weak Content-Security-Policy', severity: 'Low', confirmed: true, component: where, evidence: csp.slice(0, 300), description: "'unsafe-inline' or wildcard sources weaken CSP.", fix: 'Use nonces/hashes; remove wildcards.' }); else setCheck(N, 'csp', 'passed', 'CSP present without unsafe-inline scripts');
  const need = { 'x-content-type-options': 'nosniff', 'referrer-policy': null, 'x-frame-options': null }; const miss = Object.keys(need).filter(h => !H(h) && !(h === 'x-frame-options' && /frame-ancestors/.test(csp || '')));
  if (miss.length) add(N, { check_id: 'headers', name: 'Missing security headers', severity: 'Low', confirmed: true, component: where, evidence: 'Absent: ' + miss.join(', '), description: 'Defence-in-depth headers are not set.', fix: 'Set X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin, and frame-ancestors/X-Frame-Options.' }); else setCheck(N, 'headers', 'passed', 'Present');
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []; const bad = sc.filter(c => !/;\s*secure/i.test(c) || !/;\s*httponly/i.test(c) || !/;\s*samesite/i.test(c));
  if (bad.length) add(N, { check_id: 'cookies', name: 'Cookie missing Secure/HttpOnly/SameSite', severity: 'Medium', confirmed: true, component: where, evidence: bad.map(c => c.split('=')[0] + ' → flags: ' + c.split(';').slice(1).join(';').trim()).join('\n'), description: 'Weak cookie flags enable theft or CSRF.', fix: 'Set Secure; HttpOnly; SameSite=Lax/Strict.' });
  else setCheck(N, 'cookies', sc.length ? 'passed' : 'passed', sc.length ? 'All cookies flagged' : 'Site sets no cookies on the landing page (authenticated pages not scanned)');
  try { const c = await get(target + '/', { headers: { Origin: 'https://evil.example' } }), ao = c.headers.get('access-control-allow-origin'), cr = c.headers.get('access-control-allow-credentials');
    if (ao === 'https://evil.example' || (ao === '*' && cr === 'true')) add(N, { check_id: 'cors', name: 'CORS reflects untrusted origin', severity: cr === 'true' ? 'High' : 'Medium', confirmed: true, component: where, evidence: `Origin: https://evil.example → ACAO: ${ao}, ACAC: ${cr}`, description: 'Any site can read responses from the browser of a signed-in user.', fix: 'Allow-list your own origins.' }); else setCheck(N, 'cors', 'passed', 'Untrusted origin not reflected'); } catch { setCheck(N, 'cors', 'unverified', 'CORS probe failed'); }
  const probes = [['/.env', /^[A-Z0-9_]+\s*=/m], ['/.git/config', /\[core\]/], ['/.git/HEAD', /^ref:/], ['/supabase/config.toml', /project_id|\[api\]/], ['/package.json', /"dependencies"|"scripts"/], ['/backup.sql', /CREATE TABLE|INSERT INTO/i], ...(CFG.extraPaths || []).map(p => [p, /./])];
  let hit = 0, tested = 0; for (const [p, re] of probes) { try { const r = await get(target + p); tested++; const b = r.status === 200 ? (await r.text()).slice(0, 4000) : ''; if (b && re.test(b) && !/<html/i.test(b.slice(0, 200))) { hit++; add(N, { check_id: 'exposed', name: 'Sensitive file publicly readable', severity: /env|git|sql/.test(p) ? 'Critical' : 'Medium', confirmed: true, component: target + p, evidence: `GET ${p} → 200 with matching content signature (content not stored)`, description: 'Source, configuration or data is downloadable by anyone.', fix: 'Remove it from the web root and rotate anything it contained.' }); } } catch { } }
  if (!hit) setCheck(N, 'exposed', tested ? 'passed' : 'unverified', tested ? `${tested} well-known sensitive paths returned no matching content (not an exhaustive crawl)` : 'Probes failed');
  const waf = [['cf-ray', 'Cloudflare'], ['x-sucuri-id', 'Sucuri'], ['x-amz-cf-id', 'AWS CloudFront'], ['x-vercel-id', 'Vercel'], ['x-nf-request-id', 'Netlify']].filter(([h]) => H(h)).map(x => x[1]);
  setCheck(N, 'waf', 'unverified', waf.length ? `Edge provider detected via headers (${waf.join(', ')}), but WAF rules/mode are not exposed — status unverified` : 'No WAF/CDN signature in response headers; WAF status is not externally verifiable');
}

/* ---------- 5 · API / EDGE FUNCTIONS (GET + OPTIONS only; no request bodies, no side effects) ---------- */
async function api() {
  const P = 'api', names = fnFiles.map(fnName);
  const staticIds = ['authz', 'inputval', 'permissions'];
  const sa = R.appvuln.findings; const hasF = (chk, n) => [...sa.values()].some(f => f.check_id === chk && f.component.includes(n));
  if (!names.length) unverified(P, [...ids.api, ...staticIds], 'No Edge Functions found in repository'); else {
    staticIds.forEach(id => setCheck(P, id, 'passed', 'Static rules matched nothing'));
    for (const n of names) { const t = read(fnFiles.find(f => fnName(f) === n));
      if (hasF('idor', n)) add(P, { check_id: 'authz', name: 'Authorization not enforced per object', severity: 'High', component: `supabase/functions/${n}`, evidence: 'See Application Vulnerabilities → IDOR', description: 'Caller-supplied object ids are not tied to the authenticated user.', fix: 'Assert ownership server-side.' });
      if (hasF('inputval', n)) add(P, { check_id: 'inputval', name: 'Weak input validation on API endpoint', severity: 'Medium', component: `supabase/functions/${n}`, evidence: 'No schema/type checks found', description: 'Payment/wallet/order endpoints must validate every field.', fix: 'Add schema validation.' });
      if (/SERVICE_ROLE/.test(t)) add(P, { check_id: 'permissions', name: 'Edge Function uses the service-role key', severity: 'Informational', component: `supabase/functions/${n}`, evidence: 'SERVICE_ROLE referenced', description: 'The service-role key bypasses RLS; every code path must authorise explicitly. Not a defect by itself.', fix: 'Use a user-scoped client where RLS can enforce access; keep service-role calls minimal and audited.' });
      if (/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/i.test(t)) add(P, { check_id: 'cors', name: 'Edge Function declares wildcard CORS', severity: 'Medium', component: `supabase/functions/${n}`, evidence: 'Access-Control-Allow-Origin: * in source', description: 'Any origin may call the function from a browser.', fix: 'Allow-list origins.' });
      if (/(\.stack|JSON\.stringify\(\s*(e|err|error)\s*\)|message:\s*(e|err|error)\.message)/.test(t)) add(P, { check_id: 'errors', name: 'Error details returned to client', severity: 'Low', component: `supabase/functions/${n}`, evidence: 'Error message/stack appears in a response path', description: 'Internal errors can reveal table names, SQL and paths.', fix: 'Log details server-side; return a generic message and request id.' });
      if (!/rate.?limit|ratelimit|\b429\b|upstash/i.test(t)) add(P, { check_id: 'ratelimit', name: 'No rate-limiting logic in function source', severity: /pay|wallet|order|auth|login|otp|admin|transfer/i.test(n) ? 'Medium' : 'Low', component: `supabase/functions/${n}`, evidence: 'No rate-limit code or 429 handling found (a platform/WAF limiter would not be visible here)', description: 'Unthrottled endpoints allow brute force and abuse.', fix: 'Add per-user/IP limits (e.g. a counter table or Upstash) or enforce at the edge.' }); } }
  if (!supa || !okHost(supa) || !names.length) return unverified(P, ['auth', 'ratelimit', 'cors', 'exposure', 'errors'].filter(i => !R.api.checks[i]), 'SCAN_SUPABASE_URL not allow-listed or no functions — dynamic probes not run');
  const list = (CFG.probeFunctions || names).filter(n => names.includes(n)); let probed = 0, authFail = 0;
  for (const n of list) { const url = `${supa}/functions/v1/${n}`, pub = CFG.publicFunctions.includes(n);
    try { const r = await get(url, { method: 'GET' }), body = (await r.text()).slice(0, 3000); probed++;
      if (r.status >= 200 && r.status < 300 && !pub) { authFail++; add(P, { check_id: 'auth', name: 'Endpoint answered an unauthenticated request', severity: /pay|wallet|order|admin|transfer|user/i.test(n) ? 'Critical' : 'High', confirmed: true, component: `${n} (GET ${url.replace(/^https?:\/\//, '')})`, evidence: `GET without Authorization → HTTP ${r.status}`, description: 'The endpoint returned success to a caller with no credentials. Confirmed by a live request.', fix: 'Require and verify a user token (or signature) before any logic; if intentionally public add it to publicFunctions.' }); }
      if (/\bat\s+\S+\s*\(?(file|https?):|\/home\/|deno:\/\/|PostgrestError|syntax error at|relation "\w+" does not exist/i.test(body)) add(P, { check_id: 'errors', name: 'Error response leaks internals', severity: 'Medium', confirmed: true, component: n, evidence: 'Response body contains stack/SQL/path markers (body not stored)', description: 'Verbose errors help attackers map the system.', fix: 'Return generic errors.' });
      if (/service_role|"email"\s*:\s*"[^"]+@|eyJ[\w-]{10,}\.[\w-]{10,}\./.test(body) && r.status < 400) add(P, { check_id: 'exposure', name: 'Sensitive data in unauthenticated response', severity: 'High', confirmed: true, component: n, evidence: 'Unauthenticated response contained email/JWT/service-role markers (body not stored)', description: 'Data is returned without authentication.', fix: 'Authenticate first; minimise returned fields.' });
      const o = await get(url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }), ao = o.headers.get('access-control-allow-origin');
      if (ao === '*' || ao === 'https://evil.example') add(P, { check_id: 'cors', name: ao === '*' ? 'Endpoint allows any origin' : 'Endpoint reflects untrusted origin', severity: 'Medium', confirmed: true, component: n, evidence: `OPTIONS Origin: https://evil.example → ACAO ${ao}`, description: 'Browsers on any site may call this endpoint.', fix: 'Allow-list your origins.' });
    } catch (e) { /* unreachable function: that function stays unverified */ } }
  if (!probed) return unverified(P, ['auth', 'cors', 'exposure', 'errors'].filter(i => !R.api.checks[i] || R.api.checks[i].status === 'passed'), 'Probes could not reach any function');
  ['auth', 'exposure'].forEach(i => setCheck(P, i, 'passed', `${probed}/${list.length} functions probed with GET, no credentials; none returned success (POST handlers are not exercised — safe by design)`));
  ['cors', 'errors'].forEach(i => setCheck(P, i, 'passed', `${probed} functions probed`));
  const rp = (CFG.rateProbe || []).filter(n => names.includes(n));
  if (rp.length) { for (const n of rp) { let got429 = false; for (let i = 0; i < 25 && !got429; i++) { try { got429 = (await get(`${supa}/functions/v1/${n}`)).status === 429; } catch { break; } } if (!got429) add(P, { check_id: 'ratelimit', name: 'No throttling observed under 25 rapid requests', severity: 'Medium', confirmed: true, component: n, evidence: '25 sequential GETs, no HTTP 429', description: 'No request limiting was observed.', fix: 'Add rate limiting.' }); } }
  // ratelimit: static findings already set 'failed'; otherwise passed only if every function contains limiter code
  if (!R.api.checks.ratelimit) setCheck(P, 'ratelimit', 'passed', 'Limiter logic present in all function sources (effectiveness not load-tested)');
}

/* ---------- send (HMAC-signed) ---------- */
const MODNAMES = ['appvuln', 'deps', 'secrets', 'network', 'api'];
await network(); await api();
for (const m of MODNAMES) for (const id of (({ appvuln: ['sqli', 'xss', 'csrf', 'authbypass', 'idor', 'session', 'inputval', 'apiaccess'], deps: ['npm-audit'], secrets: ['gitleaks', 'service-role'], network: ids.network, api: [...ids.api, 'authz', 'inputval', 'permissions'] })[m])) if (!R[m].checks[id]) setCheck(m, id, 'unverified', 'Not run');
const started = new Date().toISOString(), sha = ENV.GITHUB_SHA || '';
let failedSend = 0;
for (const m of MODNAMES) {
  const body = JSON.stringify({ module: m, external_id: `${ENV.GITHUB_RUN_ID || Date.now()}-${ENV.GITHUB_RUN_ATTEMPT || 1}-${m}`, commit_sha: sha, started_at: started,
    summary: { findings: R[m].findings.size }, checks: Object.values(R[m].checks), findings: [...R[m].findings.values()] });
  console.log(`[${m}] ` + Object.values(R[m].checks).map(c => `${c.id}:${c.status}`).join(' ') + ` · ${R[m].findings.size} finding(s)`);
  if (!ENV.SECURITY_INGEST_URL || !ENV.SECURITY_INGEST_SECRET) { console.log('  (not sent: SECURITY_INGEST_URL / SECURITY_INGEST_SECRET not configured)'); failedSend = 1; continue; }
  const ts = String(Date.now()), sig = crypto.createHmac('sha256', ENV.SECURITY_INGEST_SECRET).update(ts + '.' + body).digest('hex');
  const r = await fetch(ENV.SECURITY_INGEST_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gsec-timestamp': ts, 'x-gsec-signature': sig }, body });
  console.log(`  ingest → HTTP ${r.status}`); if (!r.ok) failedSend = 1;
}
process.exit(failedSend);
