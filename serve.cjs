// إتقان — static server + order API (uploads, storage) + admin API + email notify.
// Prefer IPv4 for all DNS lookups — the host has no outbound IPv6 (SMTP gets ENETUNREACH on ::).
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const nodemailer = require('nodemailer');

const ROOT = __dirname;
const PORT = process.env.PORT || 8000;
// Persistent data lives under DATA_DIR (set it to a mounted volume in production,
// e.g. Railway volume at /data). Defaults to the project folder for local runs.
const DATA_DIR = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_DIR = path.join(DATA_DIR, 'orders');
const ORDERS_DB = path.join(ORDERS_DIR, 'orders.json');

// ---- admin auth ----
// Secrets live in admin-config.json (NOT committed). See admin-config.example.json.
// { "adminKey": "...", "allowedEmails": ["a@x.com", "b@y.com"] }
function loadAdminConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'admin-config.json'), 'utf8')); }
  catch { return {}; }
}
const ADMIN_CONFIG = loadAdminConfig();
const ADMIN_KEY = process.env.ADMIN_KEY || ADMIN_CONFIG.adminKey || 'change-me';
// Only these emails may sign into the dashboard (with the password). Empty ⇒ nobody.
// Source priority: ALLOWED_EMAILS env (comma-separated) > admin-config.json.
const ALLOWED_ADMIN_EMAILS = (
  (process.env.ALLOWED_EMAILS ? process.env.ALLOWED_EMAILS.split(',') : ADMIN_CONFIG.allowedEmails) || []
).map(function (e) { return String(e).trim().toLowerCase(); }).filter(Boolean);
function isAllowedEmail(email) {
  // No allowlist configured ⇒ the password alone gates access (any email is accepted).
  // Set ALLOWED_EMAILS (or admin-config.json) to restrict login to specific addresses.
  if (ALLOWED_ADMIN_EMAILS.length === 0) return true;
  return ALLOWED_ADMIN_EMAILS.indexOf(String(email || '').trim().toLowerCase()) !== -1;
}

// ---- email notifications (optional; activate by setting env vars) ----
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_EMAIL, MAIL_FROM
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.ADMIN_EMAIL) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    family: 4, // force IPv4 — Railway containers have no outbound IPv6 (ENETUNREACH)
    pool: true,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  console.log('✉️  إشعارات البريد مُفعّلة (SMTP) → ' + process.env.ADMIN_EMAIL);
}

// Preferred on Railway/cloud: send over HTTPS (port 443) via Brevo's API — SMTP ports
// (465/587) are blocked outbound on the free plan, so nodemailer times out there.
// Set BREVO_API_KEY (+ MAIL_FROM, ADMIN_EMAIL). The MAIL_FROM email must be a
// "verified sender" in your Brevo account.
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
if (BREVO_API_KEY) {
  console.log('✉️  إشعارات البريد مُفعّلة (Brevo HTTP API) → ' + (process.env.ADMIN_EMAIL || ''));
} else if (!mailer) {
  console.log('ℹ️  إشعارات البريد غير مُفعّلة (تُسجّل في الطرفية فقط). اضبط BREVO_API_KEY أو SMTP_* لتفعيلها.');
}

// Parse "اسم <email@x.com>" or a bare "email@x.com" into { name, email }.
function parseAddr(s, fallbackName) {
  s = String(s || '').trim();
  const m = /^(.*?)<\s*([^>]+?)\s*>$/.exec(s);
  if (m) return { name: m[1].trim() || fallbackName || '', email: m[2].trim() };
  return { name: fallbackName || '', email: s };
}

// Send one notification via Brevo's transactional email API (HTTPS, retry on transient failure).
function sendViaBrevo(mailOpts, num) {
  const sender = parseAddr(mailOpts.from, 'إتقان');
  const to = String(mailOpts.to || '').split(',').map(function (e) { return e.trim(); })
    .filter(Boolean).map(function (e) { return { email: e }; });
  const payload = JSON.stringify({
    sender: sender,
    to: to,
    subject: mailOpts.subject,
    htmlContent: mailOpts.html,
    textContent: mailOpts.text,
  });
  (function send(tries) {
    const req = https.request({
      method: 'POST', host: 'api.brevo.com', path: '/v3/smtp/email',
      headers: {
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
        'accept': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 20000,
    }, function (resp) {
      let body = '';
      resp.on('data', function (c) { body += c; });
      resp.on('end', function () {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          console.log(`✅ إشعار ${num} أُرسل (Brevo)`);
        } else {
          console.error(`فشل إرسال البريد ${num} (Brevo ${resp.statusCode}، متبقٍ ${tries - 1}):`, body.slice(0, 300));
          if (tries > 1) setTimeout(function () { send(tries - 1); }, 5000);
        }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) {
      console.error(`فشل إرسال البريد ${num} (Brevo، متبقٍ ${tries - 1}):`, e.message);
      if (tries > 1) setTimeout(function () { send(tries - 1); }, 5000);
    });
    req.write(payload);
    req.end();
  })(3);
}

function notifyNewOrder(order) {
  const num = '#' + order.id;
  const addons = (order.addons && order.addons.join('، ')) || 'لا يوجد';
  const deadline = order.deadline || 'غير محدد';
  const lines = [
    `طلب جديد ${num}`,
    `الخدمة: ${order.service}`,
    `الاسم: ${order.customer.name}`,
    `واتساب: ${order.customer.whatsapp}`,
    `البريد: ${order.customer.email}`,
    `المادة: ${order.subject}`,
    `الموعد: ${deadline}`,
    `الإضافات: ${addons}`,
    `الملفات: ${order.files.length}`,
  ];
  console.log('\n📩 ' + lines.join('\n   '));
  if (!BREVO_API_KEY && !mailer) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (k, v) => `<tr><td style="padding:9px 14px;color:#7a8aa0;border-bottom:1px solid #eef1f4;">${k}</td><td style="padding:9px 14px;color:#11283f;font-weight:600;border-bottom:1px solid #eef1f4;">${esc(v)}</td></tr>`;
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const btn = siteUrl ? `<div style="padding:18px 20px;"><a href="${siteUrl}/admin" style="display:inline-block;background:linear-gradient(135deg,#e8cd82,#a9802e);color:#1a1206;text-decoration:none;padding:11px 26px;border-radius:9px;font-weight:700;">فتح لوحة التحكم</a></div>` : '';
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e7eaee;border-radius:14px;overflow:hidden;">
    <div style="background:#0c1a2b;color:#e8cd82;padding:18px 22px;font-size:18px;font-weight:700;">إتقان — طلب جديد ${num}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;">
      ${row('الخدمة', order.service)}${row('المادة', order.subject)}${row('الاسم', order.customer.name)}${row('واتساب', order.customer.whatsapp)}${row('البريد', order.customer.email)}${row('الموعد', deadline)}${row('الإضافات', addons)}${row('عدد الملفات', order.files.length)}
    </table>${btn}
  </div>`;
  const mailOpts = {
    from: process.env.MAIL_FROM || ('إتقان <' + (process.env.SMTP_USER || '') + '>'),
    to: process.env.ADMIN_EMAIL,
    subject: `طلب جديد ${num} — ${order.service}`,
    text: lines.join('\n'),
    html: html,
  };
  // Prefer Brevo over HTTPS (works on Railway, where outbound SMTP is blocked).
  if (BREVO_API_KEY) { sendViaBrevo(mailOpts, num); return; }
  // Retry a few times — cloud→SMTP connections occasionally time out transiently.
  (function send(tries) {
    mailer.sendMail(mailOpts)
      .then((info) => console.log(`✅ إشعار ${num} أُرسل: ${info.response || 'OK'}`))
      .catch((e) => {
        console.error(`فشل إرسال البريد ${num} (متبقٍ ${tries - 1}):`, e.message);
        if (tries > 1) setTimeout(() => send(tries - 1), 5000);
      });
  })(3);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

// Upload constraints
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.zip']);
const ORDER_STATUSES = ['new', 'in_progress', 'ready', 'delivered'];

fs.mkdirSync(ORDERS_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_DB)) fs.writeFileSync(ORDERS_DB, '[]', 'utf8');

function readOrders() { try { return JSON.parse(fs.readFileSync(ORDERS_DB, 'utf8')); } catch { return []; } }
function writeOrders(list) { fs.writeFileSync(ORDERS_DB, JSON.stringify(list, null, 2), 'utf8'); }

// Simple sequential order numbers starting at 1001 (displayed as #1001).
const COUNTER_DB = path.join(ORDERS_DIR, 'counter.json');
function nextOrderNumber() {
  let last = 1000;
  try { last = JSON.parse(fs.readFileSync(COUNTER_DB, 'utf8')).last || 1000; } catch { /* first run */ }
  const n = last + 1;
  fs.writeFileSync(COUNTER_DB, JSON.stringify({ last: n }), 'utf8');
  return String(n);
}

// ---- portfolio / work samples (manageable from the dashboard) ----
const WORK_DB = path.join(DATA_DIR, 'work.json');
const WORK_IMG_DIR = path.join(DATA_DIR, 'work-images');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const WORK_DEFAULTS = [
  { id: 'w1', tag: 'ملخص دراسي', title: 'أحياء — الفصل الثالث', image: null },
  { id: 'w2', tag: 'عرض تقديمي', title: 'مبادئ الإدارة', image: null },
  { id: 'w3', tag: 'أسئلة مراجعة', title: 'محاسبة مالية', image: null },
];
fs.mkdirSync(WORK_IMG_DIR, { recursive: true });
if (!fs.existsSync(WORK_DB)) fs.writeFileSync(WORK_DB, JSON.stringify(WORK_DEFAULTS, null, 2), 'utf8');

function readWork() { try { return JSON.parse(fs.readFileSync(WORK_DB, 'utf8')); } catch { return WORK_DEFAULTS.slice(); } }
function writeWork(list) { fs.writeFileSync(WORK_DB, JSON.stringify(list, null, 2), 'utf8'); }

// ---- site settings (editable from the dashboard) ----
const SETTINGS_DB = path.join(DATA_DIR, 'settings.json');
const SETTINGS_DEFAULTS = { whatsapp: '96893890037' };
if (!fs.existsSync(SETTINGS_DB)) fs.writeFileSync(SETTINGS_DB, JSON.stringify(SETTINGS_DEFAULTS, null, 2), 'utf8');
function readSettings() { try { return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(fs.readFileSync(SETTINGS_DB, 'utf8'))); } catch { return Object.assign({}, SETTINGS_DEFAULTS); } }
function writeSettings(s) { fs.writeFileSync(SETTINGS_DB, JSON.stringify(s, null, 2), 'utf8'); }

function sanitizeName(name) {
  return (path.basename(name || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120)) || 'file';
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function isAuthed(req) { return (req.headers['x-admin-key'] || '') === ADMIN_KEY; }
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// ---------- POST /api/order (public) ----------
function handleOrder(req, res) {
  let bb;
  try { bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES } }); }
  catch { return sendJson(res, 400, { ok: false, error: 'صيغة الطلب غير صحيحة.' }); }

  const orderId = nextOrderNumber();
  const orderDir = path.join(ORDERS_DIR, orderId);
  fs.mkdirSync(orderDir, { recursive: true });

  const fields = {}; const addons = []; const files = []; const pending = [];
  let aborted = false; let rejectedExt = null;

  function fail(status, message) {
    if (aborted) return; aborted = true;
    try { req.unpipe(bb); } catch {}
    fs.rm(orderDir, { recursive: true, force: true }, () => {});
    sendJson(res, status, { ok: false, error: message });
  }

  bb.on('field', (name, val) => { if (name === 'addons') addons.push(val); else fields[name] = val; });
  bb.on('file', (name, stream, info) => {
    const original = sanitizeName(info.filename);
    const ext = path.extname(original).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) { rejectedExt = ext || '(بدون امتداد)'; stream.resume(); return; }
    const storedName = `${crypto.randomBytes(4).toString('hex')}${ext}`;
    const dest = path.join(orderDir, storedName);
    const ws = fs.createWriteStream(dest);
    let size = 0; let tooBig = false;
    stream.on('data', (d) => { size += d.length; });
    stream.on('limit', () => { tooBig = true; });
    pending.push(new Promise((resolve) => {
      ws.on('close', () => {
        if (tooBig) { fs.unlink(dest, () => {}); return resolve(); }
        files.push({ originalName: info.filename, storedName, size });
        resolve();
      });
    }));
    stream.pipe(ws);
  });
  bb.on('error', () => fail(400, 'حدث خطأ أثناء رفع الملفات.'));
  bb.on('close', async () => {
    if (aborted) return;
    await Promise.all(pending);
    if (rejectedExt) return fail(415, `نوع ملف غير مدعوم: ${rejectedExt}`);
    for (const k of ['name', 'email', 'whatsapp', 'service']) {
      if (!fields[k] || !String(fields[k]).trim()) return fail(422, 'الرجاء تعبئة الحقول المطلوبة.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return fail(422, 'صيغة البريد الإلكتروني غير صحيحة.');

    const order = {
      id: orderId, createdAt: new Date().toISOString(), status: 'new',
      service: fields.service || '', subject: fields.subject || '',
      deadline: fields.deadline || '', notes: fields.notes || '', addons,
      customer: { name: fields.name || '', email: fields.email || '', whatsapp: fields.whatsapp || '' },
      files,
    };
    const list = readOrders(); list.push(order); writeOrders(list);
    notifyNewOrder(order);
    sendJson(res, 200, { ok: true, orderId, fileCount: files.length });
  });
  req.pipe(bb);
}

// ---------- admin endpoints ----------
function handleListOrders(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const orders = readOrders().slice().reverse(); // newest first
  sendJson(res, 200, { ok: true, orders });
}

async function handleStatus(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  if (!body.id || ORDER_STATUSES.indexOf(body.status) === -1) return sendJson(res, 400, { ok: false, error: 'بيانات غير صحيحة.' });
  const list = readOrders();
  const o = list.find((x) => x.id === body.id);
  if (!o) return sendJson(res, 404, { ok: false, error: 'الطلب غير موجود.' });
  o.status = body.status; writeOrders(list);
  sendJson(res, 200, { ok: true });
}

function handleFile(req, res, query) {
  if (!isAuthed(req)) { res.writeHead(401); return res.end('Unauthorized'); }
  const id = query.get('id') || '';
  const name = query.get('name') || '';
  if (!/^\d{3,}$/.test(id) || !/^[a-f0-9]{8}\.[a-z0-9]+$/i.test(name)) {
    res.writeHead(400); return res.end('Bad request');
  }
  const list = readOrders();
  const order = list.find((x) => x.id === id);
  const meta = order && order.files.find((f) => f.storedName === name);
  if (!meta) { res.writeHead(404); return res.end('Not found'); }
  const filePath = path.join(ORDERS_DIR, id, name);
  if (!filePath.startsWith(ORDERS_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(filePath).toLowerCase();
  const dispName = encodeURIComponent(meta.originalName || name);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `inline; filename*=UTF-8''${dispName}`,
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- portfolio / work samples ----------
function handleWorkList(res) {
  sendJson(res, 200, { ok: true, items: readWork() });
}

async function handleWorkSave(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  if (!Array.isArray(body.items)) return sendJson(res, 400, { ok: false, error: 'بيانات غير صحيحة.' });
  const existing = readWork();
  const cleaned = body.items.slice(0, 12).map((it, i) => {
    const prev = existing.find((x) => x.id === it.id);
    return {
      id: (it.id && /^w[a-z0-9]+$/i.test(it.id)) ? it.id : ('w' + crypto.randomBytes(3).toString('hex')),
      tag: String(it.tag || '').slice(0, 60),
      title: String(it.title || '').slice(0, 120),
      image: prev ? prev.image : (it.image || null),
    };
  });
  // delete image files that are no longer referenced
  const keep = new Set(cleaned.map((x) => x.image).filter(Boolean));
  existing.forEach((old) => {
    if (old.image && !keep.has(old.image)) {
      fs.unlink(path.join(WORK_IMG_DIR, old.image), () => {});
    }
  });
  writeWork(cleaned);
  sendJson(res, 200, { ok: true, items: cleaned });
}

function handleWorkImage(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  let bb;
  try { bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: 8 * 1024 * 1024, files: 1 } }); }
  catch { return sendJson(res, 400, { ok: false, error: 'صيغة غير صحيحة.' }); }
  let workId = '';
  let stored = null;
  let rejected = false;
  const pending = [];
  bb.on('field', (n, v) => { if (n === 'id') workId = v; });
  bb.on('file', (n, stream, info) => {
    const ext = path.extname(sanitizeName(info.filename)).toLowerCase();
    if (!IMAGE_EXT.has(ext)) { rejected = true; stream.resume(); return; }
    const name = `${crypto.randomBytes(5).toString('hex')}${ext}`;
    const dest = path.join(WORK_IMG_DIR, name);
    const ws = fs.createWriteStream(dest);
    pending.push(new Promise((r) => ws.on('close', () => { stored = name; r(); })));
    stream.pipe(ws);
  });
  bb.on('close', async () => {
    await Promise.all(pending);
    if (rejected || !stored) return sendJson(res, 415, { ok: false, error: 'الرجاء رفع صورة (PNG/JPG/WEBP).' });
    const list = readWork();
    const item = list.find((x) => x.id === workId);
    if (!item) { fs.unlink(path.join(WORK_IMG_DIR, stored), () => {}); return sendJson(res, 404, { ok: false, error: 'النموذج غير موجود.' }); }
    if (item.image) fs.unlink(path.join(WORK_IMG_DIR, item.image), () => {}); // remove old
    item.image = stored;
    writeWork(list);
    sendJson(res, 200, { ok: true, id: workId, image: stored });
  });
  req.pipe(bb);
}

// Serve uploaded portfolio images from DATA_DIR (which may be a mounted volume).
function handleWorkImageFile(res, urlPath) {
  const name = path.basename(urlPath);
  if (!/^[a-f0-9]+\.(png|jpe?g|webp)$/i.test(name)) { res.writeHead(404); return res.end('Not found'); }
  const fp = path.join(WORK_IMG_DIR, name);
  if (!fp.startsWith(WORK_IMG_DIR) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
  fs.createReadStream(fp).pipe(res);
}

// ---------- static ----------
// Files/folders that must NEVER be served (secrets, VCS, local config, runtime data).
const STATIC_DENY = new Set(['admin-config.json', 'admin-config.example.json', 'work.json', 'settings.json', 'package.json', 'package-lock.json', 'serve.cjs']);
function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/admin' || urlPath === '/admin/') urlPath = '/admin.html';
  // Block hidden paths (.git, .claude, .gitignore, …) and denylisted files.
  const segments = urlPath.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.')) || STATIC_DENY.has(path.basename(urlPath))) {
    res.writeHead(404); return res.end('Not found');
  }
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  if (filePath.startsWith(ORDERS_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = decodeURIComponent(parsed.pathname);

  if (req.method === 'POST' && urlPath === '/api/order') return handleOrder(req, res);
  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    const body = await readBody(req);
    const ok = isAllowedEmail(body.email) && body.key === ADMIN_KEY;
    return sendJson(res, 200, { ok, emailAllowed: isAllowedEmail(body.email) });
  }
  if (req.method === 'GET' && urlPath === '/api/orders') return handleListOrders(req, res);
  if (req.method === 'POST' && urlPath === '/api/order/status') return handleStatus(req, res);
  if (req.method === 'GET' && urlPath === '/api/order/file') return handleFile(req, res, parsed.searchParams);
  if (req.method === 'GET' && urlPath === '/api/work') return handleWorkList(res);
  if (req.method === 'POST' && urlPath === '/api/work/save') return handleWorkSave(req, res);
  if (req.method === 'POST' && urlPath === '/api/work/image') return handleWorkImage(req, res);
  if (req.method === 'GET' && urlPath.startsWith('/work-images/')) return handleWorkImageFile(res, urlPath);
  if (req.method === 'GET' && urlPath === '/api/settings') return sendJson(res, 200, { ok: true, settings: readSettings() });
  if (req.method === 'POST' && urlPath === '/api/settings') {
    if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
    const body = await readBody(req);
    const digits = String(body.whatsapp || '').replace(/[^0-9]/g, '').slice(0, 20);
    if (digits.length < 7) return sendJson(res, 400, { ok: false, error: 'رقم واتساب غير صحيح.' });
    const s = readSettings(); s.whatsapp = digits; writeSettings(s);
    return sendJson(res, 200, { ok: true, settings: s });
  }

  return serveStatic(req, res, urlPath);
}).listen(PORT, () => {
  console.log(`إتقان running at http://localhost:${PORT}`);
  console.log(`لوحة الإدارة: http://localhost:${PORT}/admin  (كلمة المرور: ${ADMIN_KEY})`);
});
