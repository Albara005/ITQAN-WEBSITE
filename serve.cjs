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
const JSZip = require('jszip');

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

// Shared email helpers (used for both admin and customer notifications).
const MAIL_FROM = process.env.MAIL_FROM || ('إتقان <' + (process.env.SMTP_USER || 'no-reply@itqanoman.co') + '>');
// Canonical public URL — hardcoded so email/dashboard links can never point to an old host.
// (Ignores any SITE_URL env var, which previously pointed at the old Railway domain.)
const SITE_URL = 'https://www.itqanoman.co';
const STATUS_AR = { new: 'جديد', in_progress: 'قيد العمل', ready: 'جاهز', delivered: 'مُسلّم' };
const STATUS_DESC_AR = { new: 'استلمنا طلبك', in_progress: 'جارٍ تجهيز طلبك', ready: 'اكتمل وجاهز للتسليم', delivered: 'تم تسليم طلبك' };
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// Route an email through Brevo (preferred on Railway) or SMTP, with retry.
function deliverMail(mailOpts, tag) {
  if (BREVO_API_KEY) { sendViaBrevo(mailOpts, tag); return; }
  if (!mailer) return;
  (function send(tries) {
    mailer.sendMail(mailOpts)
      .then((info) => console.log(`✅ ${tag} أُرسل: ${info.response || 'OK'}`))
      .catch((e) => { console.error(`فشل إرسال البريد ${tag} (متبقٍ ${tries - 1}):`, e.message); if (tries > 1) setTimeout(() => send(tries - 1), 5000); });
  })(3);
}

// Customer-facing email body (order confirmation / status update) with a track button.
function customerEmailHtml(order, opts) {
  const trackUrl = `${SITE_URL}/?track=${order.id}`;
  const row = (k, v) => `<tr><td style="padding:9px 14px;color:#7a8aa0;border-bottom:1px solid #eef1f4;">${k}</td><td style="padding:9px 14px;color:#11283f;font-weight:600;border-bottom:1px solid #eef1f4;">${escHtml(v)}</td></tr>`;
  const addons = (order.addons && order.addons.join('، ')) || 'لا يوجد';
  return `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e7eaee;border-radius:14px;overflow:hidden;">
    <div style="background:#0c1a2b;color:#e8cd82;padding:20px 22px;font-size:19px;font-weight:700;">إتقان — ${opts.heading}</div>
    <div style="padding:20px 22px;color:#11283f;">
      <p style="font-size:15px;line-height:1.9;margin:0 0 16px;">${opts.intro}</p>
      ${opts.statusHtml || ''}
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        ${row('رقم الطلب', '#' + order.id)}${row('الخدمة', order.service)}${row('المادة', order.subject || '—')}${row('الموعد', order.deadline || 'غير محدد')}${row('الإضافات', addons)}${order.sizeTier ? row('حجم الطلب', SIZE_LABELS[order.sizeTier] + ' — ' + order.price + ' ر.ع') : ''}${order.discount ? row('كود الخصم', order.discount.code + ' (' + order.discount.percent + '%)') : ''}
      </table>
      <div style="text-align:center;padding:24px 0 8px;">
        <a href="${trackUrl}" style="display:inline-block;background:linear-gradient(135deg,#e8cd82,#a9802e);color:#1a1206;text-decoration:none;padding:13px 34px;border-radius:10px;font-weight:800;font-size:15px;">تتبّع حالة طلبك</a>
      </div>
      <p style="font-size:12.5px;color:#7a8aa0;text-align:center;margin:6px 0 0;">أو افتح الرابط: ${trackUrl}</p>
    </div>
  </div>`;
}

// Email the customer a confirmation right after they place an order.
function notifyCustomerOrder(order) {
  const email = order.customer && order.customer.email;
  if (!email) return;
  const html = customerEmailHtml(order, {
    heading: 'تأكيد طلبك #' + order.id,
    intro: `مرحبًا ${escHtml(order.customer.name || '')}، شكرًا لطلبك من إتقان! استلمنا طلبك وسنتواصل معك قريبًا عبر واتساب لتأكيد التفاصيل والدفع. يمكنك متابعة حالة طلبك في أي وقت عبر الزر بالأسفل.`,
  });
  deliverMail({ from: MAIL_FROM, to: email, subject: `تأكيد طلبك #${order.id} — إتقان`, text: `تم استلام طلبك #${order.id} من إتقان. تابع حالته: ${SITE_URL}/?track=${order.id}`, html }, 'تأكيد #' + order.id);
}

// Email the customer whenever the admin changes their order status.
function notifyCustomerStatus(order) {
  const email = order.customer && order.customer.email;
  if (!email) return;
  const label = STATUS_AR[order.status] || order.status;
  const desc = STATUS_DESC_AR[order.status] || '';
  const statusHtml = `<div style="text-align:center;margin:0 0 18px;"><span style="display:inline-block;background:rgba(201,168,76,.15);color:#a9802e;border:1px solid #e8cd82;padding:9px 24px;border-radius:999px;font-weight:800;font-size:16px;">${label}</span><div style="color:#7a8aa0;font-size:13px;margin-top:8px;">${desc}</div></div>`;
  const html = customerEmailHtml(order, {
    heading: 'تحديث حالة طلبك #' + order.id,
    intro: `مرحبًا ${escHtml(order.customer.name || '')}، تم تحديث حالة طلبك #${order.id} إلى:`,
    statusHtml,
  });
  deliverMail({ from: MAIL_FROM, to: email, subject: `تحديث طلبك #${order.id} — ${label}`, text: `حالة طلبك #${order.id}: ${label}. ${SITE_URL}/?track=${order.id}`, html }, 'حالة #' + order.id);
}

// Email the customer their finished files (secure per-order download links).
function notifyCustomerDelivery(order) {
  const email = order.customer && order.customer.email;
  if (!email) return;
  const links = (order.deliverables || []).map((d) => {
    const url = `${SITE_URL}/api/deliverable?id=${order.id}&t=${order.deliverToken}&name=${d.storedName}`;
    return `<div style="margin:9px 0;"><a href="${url}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9px;font-weight:700;font-size:15px;">⬇ تحميل: ${escHtml(d.originalName)}</a></div>`;
  }).join('');
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e7eaee;border-radius:14px;overflow:hidden;">
    <div style="background:#0c1a2b;color:#e8cd82;padding:20px 22px;font-size:19px;font-weight:700;">إتقان — طلبك #${order.id} جاهز 🎉</div>
    <div style="padding:22px;color:#11283f;">
      <p style="font-size:15px;line-height:1.9;margin:0 0 14px;">مرحبًا ${escHtml(order.customer.name || '')}، تم إنجاز طلبك «${escHtml(order.service)}» بنجاح. حمّل ملفاتك من الأزرار التالية:</p>
      ${links || '<p>—</p>'}
      <p style="font-size:12.5px;color:#7a8aa0;margin-top:16px;">هذه الروابط خاصة بك، فضلًا لا تشاركها. لأي استفسار نحن في خدمتك.</p>
    </div>
  </div>`;
  const text = `طلبك #${order.id} جاهز. حمّل ملفاتك:\n` + (order.deliverables || []).map((d) => `${SITE_URL}/api/deliverable?id=${order.id}&t=${order.deliverToken}&name=${d.storedName}`).join('\n');
  deliverMail({ from: MAIL_FROM, to: email, subject: `طلبك #${order.id} جاهز — إتقان`, text, html }, 'تسليم #' + order.id);
}

function notifyNewOrder(order) {
  const num = '#' + order.id;
  const addons = (order.addons && order.addons.join('، ')) || 'لا يوجد';
  const deadline = order.deadline || 'غير محدد';
  const discountText = order.discount ? `${order.discount.code} (${order.discount.percent}%)` : 'لا يوجد';
  const sizeText = order.sizeTier ? `${SIZE_LABELS[order.sizeTier]} — ${order.price} ر.ع (${order.sizePages} صفحة تقريبًا)` : 'غير محدد';
  const lines = [
    `طلب جديد ${num}`,
    `الخدمة: ${order.service}`,
    `الاسم: ${order.customer.name}`,
    `واتساب: ${order.customer.whatsapp}`,
    `البريد: ${order.customer.email}`,
    `المادة: ${order.subject}`,
    `الموعد: ${deadline}`,
    `الإضافات: ${addons}`,
    `كود الخصم: ${discountText}`,
    `حجم الطلب: ${sizeText}`,
    `الملفات: ${order.files.length}`,
  ];
  console.log('\n📩 ' + lines.join('\n   '));
  if (!BREVO_API_KEY && !mailer) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (k, v) => `<tr><td style="padding:9px 14px;color:#7a8aa0;border-bottom:1px solid #eef1f4;">${k}</td><td style="padding:9px 14px;color:#11283f;font-weight:600;border-bottom:1px solid #eef1f4;">${esc(v)}</td></tr>`;
  const btn = `<div style="padding:18px 20px;"><a href="${SITE_URL}/admin" style="display:inline-block;background:linear-gradient(135deg,#e8cd82,#a9802e);color:#1a1206;text-decoration:none;padding:11px 26px;border-radius:9px;font-weight:700;">فتح لوحة التحكم</a></div>`;
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e7eaee;border-radius:14px;overflow:hidden;">
    <div style="background:#0c1a2b;color:#e8cd82;padding:18px 22px;font-size:18px;font-weight:700;">إتقان — طلب جديد ${num}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;">
      ${row('الخدمة', order.service)}${row('المادة', order.subject)}${row('الاسم', order.customer.name)}${row('واتساب', order.customer.whatsapp)}${row('البريد', order.customer.email)}${row('الموعد', deadline)}${row('الإضافات', addons)}${order.discount ? `<tr><td style="padding:9px 14px;color:#7a8aa0;border-bottom:1px solid #eef1f4;">كود الخصم</td><td style="padding:9px 14px;color:#a9802e;font-weight:800;border-bottom:1px solid #eef1f4;">${esc(order.discount.code)} (${order.discount.percent}%)</td></tr>` : ''}${order.sizeTier ? `<tr><td style="padding:9px 14px;color:#7a8aa0;border-bottom:1px solid #eef1f4;">حجم الطلب</td><td style="padding:9px 14px;color:#0f766e;font-weight:800;border-bottom:1px solid #eef1f4;">${SIZE_LABELS[order.sizeTier]} — ${order.price} ر.ع</td></tr>` : ''}${row('عدد الملفات', order.files.length)}
    </table>${btn}
  </div>`;
  const mailOpts = {
    from: MAIL_FROM,
    to: process.env.ADMIN_EMAIL,
    subject: `طلب جديد ${num} — ${order.service}`,
    text: lines.join('\n'),
    html: html,
  };
  deliverMail(mailOpts, 'إشعار ' + num);
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
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.zip']);
const ORDER_STATUSES = ['new', 'in_progress', 'ready', 'delivered'];

fs.mkdirSync(ORDERS_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_DB)) fs.writeFileSync(ORDERS_DB, '[]', 'utf8');

function readOrders() { try { return JSON.parse(fs.readFileSync(ORDERS_DB, 'utf8')); } catch { return []; } }
function writeOrders(list) { fs.writeFileSync(ORDERS_DB, JSON.stringify(list, null, 2), 'utf8'); }

// ---- order size & pricing (estimated from the uploaded material's volume) ----
// Size-based pricing applies only to summary services (not PowerPoint, etc.).
const SUMMARY_SERVICES = new Set(['ملخص دراسي', 'ملخص + أسئلة مراجعة']);
const SIZE_PRICES = { small: 1, medium: 2, large: 3 };       // OMR
const SIZE_LABELS = { small: 'صغير', medium: 'متوسط', large: 'كبير' };
const SIZE_SMALL_MAX = 15;   // pages
const SIZE_MEDIUM_MAX = 40;  // pages
function tierFromPages(p) { return p <= SIZE_SMALL_MAX ? 'small' : p <= SIZE_MEDIUM_MAX ? 'medium' : 'large'; }
function countPdfPages(buf) { const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g); return m ? m.length : 1; }
// Estimate total "pages" of the order's files → size tier (no AI needed, instant).
function estimateOrderSize(orderDir, files) {
  let pages = 0;
  for (const f of files) {
    const ext = path.extname(f.storedName || '').toLowerCase();
    const fp = path.join(orderDir, f.storedName);
    try {
      if (ext === '.pdf') pages += countPdfPages(fs.readFileSync(fp));
      else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) pages += 1;
      else if (ext === '.txt') pages += Math.max(1, Math.round(fs.readFileSync(fp, 'utf8').split(/\s+/).filter(Boolean).length / 300));
      else pages += Math.max(1, Math.round((f.size || 0) / (45 * 1024))); // docx/ppt/zip — rough by size
    } catch { pages += 1; }
  }
  pages = Math.max(1, pages);
  const tier = tierFromPages(pages);
  return { pages, tier, label: SIZE_LABELS[tier], price: SIZE_PRICES[tier] };
}

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

// ---- discount codes (managed from the dashboard) ----
const DISCOUNTS_DB = path.join(DATA_DIR, 'discounts.json');
if (!fs.existsSync(DISCOUNTS_DB)) fs.writeFileSync(DISCOUNTS_DB, '[]', 'utf8');
function readDiscounts() { try { return JSON.parse(fs.readFileSync(DISCOUNTS_DB, 'utf8')); } catch { return []; } }
function writeDiscounts(list) { fs.writeFileSync(DISCOUNTS_DB, JSON.stringify(list, null, 2), 'utf8'); }
// Return the discount for `code` if it exists and hasn't expired, else null. Case-insensitive.
function findValidDiscount(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const d = readDiscounts().find((x) => String(x.code).toUpperCase() === c);
  if (!d) return null;
  if (d.expiresAt && new Date(d.expiresAt).getTime() < Date.now()) return null;
  return d;
}

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

    const disc = findValidDiscount(fields.discountCode);
    const sz = SUMMARY_SERVICES.has(fields.service) ? estimateOrderSize(orderDir, files) : null;
    const order = {
      id: orderId, createdAt: new Date().toISOString(), status: 'new',
      service: fields.service || '', subject: fields.subject || '',
      deadline: fields.deadline || '', notes: fields.notes || '', addons,
      discount: disc ? { code: disc.code, percent: disc.percent } : null,
      sizeTier: sz ? sz.tier : null, sizePages: sz ? sz.pages : null, price: sz ? sz.price : null,
      customer: { name: fields.name || '', email: fields.email || '', whatsapp: fields.whatsapp || '' },
      files,
    };
    const list = readOrders(); list.push(order); writeOrders(list);
    notifyNewOrder(order);
    notifyCustomerOrder(order);
    sendJson(res, 200, { ok: true, orderId, fileCount: files.length, sizeTier: sz ? sz.tier : null, sizeLabel: sz ? sz.label : null, price: sz ? sz.price : null, pages: sz ? sz.pages : null });
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
  notifyCustomerStatus(o);
  sendJson(res, 200, { ok: true });
}

// Admin: delete a single order (and its uploaded files).
async function handleDeleteOrder(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  const id = String(body.id || '').replace(/[^0-9]/g, '');
  if (!id) return sendJson(res, 400, { ok: false, error: 'رقم طلب غير صحيح.' });
  const list = readOrders();
  const idx = list.findIndex((x) => String(x.id) === id);
  if (idx === -1) return sendJson(res, 404, { ok: false, error: 'الطلب غير موجود.' });
  list.splice(idx, 1); writeOrders(list);
  try { fs.rmSync(path.join(ORDERS_DIR, id), { recursive: true, force: true }); } catch {}
  sendJson(res, 200, { ok: true });
}

// ---------- deliverables (final files the admin uploads & sends to the customer) ----------
const DELIVERABLE_EXT = new Set(['.pdf', '.pptx', '.ppt', '.docx', '.doc']);
const DELIV_NAME_RE = /^[a-f0-9]+\.[a-z0-9]+$/i;

// Admin: upload a finished file to an order.
function handleUploadDeliverable(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  let bb;
  try { bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: 30 * 1024 * 1024, files: 1 } }); }
  catch { return sendJson(res, 400, { ok: false, error: 'صيغة الطلب غير صحيحة.' }); }
  let orderId = ''; let stored = null; let rejected = false; let tooBig = false; const pending = [];
  bb.on('field', (n, v) => { if (n === 'id') orderId = String(v).replace(/[^0-9]/g, ''); });
  bb.on('file', (n, stream, info) => {
    const original = info.filename || 'file';
    const ext = path.extname(sanitizeName(original)).toLowerCase();
    if (!DELIVERABLE_EXT.has(ext) || !orderId) { rejected = true; stream.resume(); return; }
    const dir = path.join(ORDERS_DIR, orderId, 'deliverables');
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.randomBytes(6).toString('hex') + ext;
    const dest = path.join(dir, name);
    const ws = fs.createWriteStream(dest);
    stream.on('limit', () => { tooBig = true; });
    pending.push(new Promise((r) => ws.on('close', () => {
      if (tooBig) { fs.unlink(dest, () => {}); return r(); }
      let size = 0; try { size = fs.statSync(dest).size; } catch {}
      stored = { storedName: name, originalName: original, size }; r();
    })));
    stream.pipe(ws);
  });
  bb.on('close', async () => {
    await Promise.all(pending);
    if (rejected) return sendJson(res, 415, { ok: false, error: 'صيغة غير مدعومة (PDF/PPTX/PPT/DOCX/DOC).' });
    if (tooBig || !stored) return sendJson(res, 400, { ok: false, error: 'فشل الرفع أو الملف أكبر من 30 ميجابايت.' });
    const list = readOrders();
    const o = list.find((x) => String(x.id) === orderId);
    if (!o) { try { fs.rmSync(path.join(ORDERS_DIR, orderId, 'deliverables', stored.storedName), { force: true }); } catch {} return sendJson(res, 404, { ok: false, error: 'الطلب غير موجود.' }); }
    if (!o.deliverables) o.deliverables = [];
    o.deliverables.push(stored);
    writeOrders(list);
    sendJson(res, 200, { ok: true, deliverables: o.deliverables });
  });
  req.pipe(bb);
}

// Admin: remove a deliverable.
async function handleDeleteDeliverable(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  const id = String(body.id || '').replace(/[^0-9]/g, '');
  const name = String(body.name || '');
  if (!DELIV_NAME_RE.test(name)) return sendJson(res, 400, { ok: false, error: 'اسم غير صحيح.' });
  const list = readOrders();
  const o = list.find((x) => String(x.id) === id);
  if (!o || !o.deliverables) return sendJson(res, 404, { ok: false, error: 'غير موجود.' });
  o.deliverables = o.deliverables.filter((d) => d.storedName !== name);
  writeOrders(list);
  try { fs.rmSync(path.join(ORDERS_DIR, id, 'deliverables', name), { force: true }); } catch {}
  sendJson(res, 200, { ok: true, deliverables: o.deliverables });
}

// Download a deliverable — admin (via key) or the customer (via the order's secret token).
function handleDeliverableDownload(req, res, query) {
  const id = String(query.get('id') || '').replace(/[^0-9]/g, '');
  const name = String(query.get('name') || '');
  const token = String(query.get('t') || '');
  if (!id || !DELIV_NAME_RE.test(name)) { res.writeHead(400); return res.end('Bad request'); }
  const o = readOrders().find((x) => String(x.id) === id);
  if (!o || !o.deliverables) { res.writeHead(404); return res.end('Not found'); }
  if (!isAuthed(req) && (!o.deliverToken || token !== o.deliverToken)) { res.writeHead(403); return res.end('Forbidden'); }
  const d = o.deliverables.find((x) => x.storedName === name);
  if (!d) { res.writeHead(404); return res.end('Not found'); }
  const fp = path.join(ORDERS_DIR, id, 'deliverables', name);
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    const fn = encodeURIComponent(d.originalName || ('itqan-' + id + path.extname(name)));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Content-Disposition': "attachment; filename*=UTF-8''" + fn });
    fs.createReadStream(fp).pipe(res);
  });
}

// Admin: mark delivered and email the customer the download links.
async function handleDeliverOrder(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  const id = String(body.id || '').replace(/[^0-9]/g, '');
  const list = readOrders();
  const o = list.find((x) => String(x.id) === id);
  if (!o) return sendJson(res, 404, { ok: false, error: 'الطلب غير موجود.' });
  if (!o.deliverables || !o.deliverables.length) return sendJson(res, 400, { ok: false, error: 'ارفع ملفًا نهائيًا واحدًا على الأقل قبل التسليم.' });
  if (!o.deliverToken) o.deliverToken = crypto.randomBytes(8).toString('hex');
  o.status = 'delivered';
  writeOrders(list);
  notifyCustomerDelivery(o);
  sendJson(res, 200, { ok: true });
}

// ---------- AI summary generation (Anthropic) ----------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5';
const AI_READABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.pptx', '.docx']);
const AI_MAX_BYTES = 18 * 1024 * 1024;   // base64 budget for PDF/images (Anthropic ~32MB request limit)
const AI_MAX_TEXT = 200000;              // cap extracted text length (chars)
const AI_MAX_ZIP = 60 * 1024 * 1024;     // max pptx/docx file size to open for text extraction

function decodeXmlEntities(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'"); }
// Extract readable text from a PowerPoint (.pptx) — slide by slide.
async function extractPptxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (a.match(/(\d+)/)[1] - b.match(/(\d+)/)[1]));
  let out = '';
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    const t = (xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((x) => decodeXmlEntities(x.replace(/<[^>]+>/g, ''))).join(' ').trim();
    if (t) out += '\n• شريحة: ' + t;
    if (out.length > AI_MAX_TEXT) break;
  }
  return out;
}
// Extract readable text from a Word (.docx).
async function extractDocxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('word/document.xml'); if (!f) return '';
  const xml = await f.async('string');
  return (xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((x) => decodeXmlEntities(x.replace(/<[^>]+>/g, ''))).join(' ').slice(0, AI_MAX_TEXT);
}
const AI_SYSTEM = `أنت "وكيل إتقان" — مساعد ذكي متخصص في إعداد وتحرير الملخصات الدراسية، تتحدّث مع فريق إتقان بأسلوب طبيعي وودود ومحترف (مثل مساعد حقيقي).
- تفهم طلبات التعديل والأسئلة وتنفّذها بذكاء مع مراعاة سياق المحادثة السابقة.
- اكتب الملخص بنفس لغة مادة العميل.
- ردّك دائمًا بصيغة JSON فقط دون أي نص خارجها، بالشكل التالي:
{"reply":"ردّ قصير طبيعي بلغة المستخدم يشرح ما فعلتَه أو يجيب على سؤاله","summary":{"title":"عنوان","subject":"المادة","language":"ar|en","sections":[{"title":"القسم","points":["نقطة"],"terms":[{"term":"مصطلح","def":"تعريف"}]}]}}
- "summary" يحتوي دائمًا الملخص الكامل المحدّث (وليس التغييرات فقط)، مع إبقاء ما لم يُطلب تغييره.
- إن كان الطلب سؤالاً فقط دون تعديل، أجب في "reply" وأعد "summary" كما هو دون تغيير.
- اجعل النقاط مركّزة ومفيدة للمذاكرة، و"reply" مختصرًا وودودًا.`;

function callAnthropic(messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens || 16000, system: AI_SYSTEM, messages });
    const req = https.request({
      method: 'POST', host: 'api.anthropic.com', path: '/v1/messages',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 120000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); if (j.content) resolve(j); else reject(new Error((j.error && j.error.message) || 'خطأ من الذكاء')); }
        catch (e) { reject(new Error('تعذّر قراءة رد الذكاء')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('انتهت المهلة')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// Gather the order's readable files as Claude content blocks (PDF/images) + inline text (txt/pptx/docx).
async function buildFileContent(order) {
  const dir = path.join(ORDERS_DIR, String(order.id));
  const blocks = []; let text = ''; let bytes = 0; let skipped = 0;
  for (const f of (order.files || [])) {
    const ext = path.extname(f.storedName || '').toLowerCase();
    if (!AI_READABLE.has(ext)) { skipped++; continue; }
    const fp = path.join(dir, f.storedName);
    let stat; try { stat = fs.statSync(fp); } catch { continue; }
    try {
      if (ext === '.txt') { if (text.length < AI_MAX_TEXT) text += '\n\n' + fs.readFileSync(fp, 'utf8').slice(0, AI_MAX_TEXT); }
      else if (ext === '.pptx') { if (stat.size <= AI_MAX_ZIP && text.length < AI_MAX_TEXT) text += '\n\n[' + f.originalName + ']' + await extractPptxText(fs.readFileSync(fp)); else skipped++; }
      else if (ext === '.docx') { if (stat.size <= AI_MAX_ZIP && text.length < AI_MAX_TEXT) text += '\n\n[' + f.originalName + ']\n' + await extractDocxText(fs.readFileSync(fp)); else skipped++; }
      else if (ext === '.pdf') { if (bytes + stat.size <= AI_MAX_BYTES) { blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(fp).toString('base64') } }); bytes += stat.size; } else skipped++; }
      else { if (bytes + stat.size <= AI_MAX_BYTES) { const mt = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'; blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: fs.readFileSync(fp).toString('base64') } }); bytes += stat.size; } else skipped++; }
    } catch { skipped++; }
  }
  return { blocks, text: text.slice(0, AI_MAX_TEXT), count: blocks.length + (text ? 1 : 0), skipped };
}

function parseAgent(t) {
  t = String(t).trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('لم يُرجع الذكاء ردًّا صالحًا');
  let obj;
  try { obj = JSON.parse(t.slice(s, e + 1)); }
  catch (err) { throw new Error('الرد طويل وانقطع — جرّب طلبًا أبسط أو قسّم التعديل'); }
  if (!obj.summary || !obj.summary.sections) throw new Error('لم يُرجع الذكاء ملخصًا كاملاً');
  return { reply: obj.reply || 'تم.', summary: obj.summary };
}

// Admin: generate a summary draft from the order's uploaded files.
async function handleSummaryGenerate(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  if (!ANTHROPIC_API_KEY) return sendJson(res, 400, { ok: false, error: 'مفتاح الذكاء غير مضبوط على الخادم.' });
  const body = await readBody(req);
  const id = String(body.id || '').replace(/[^0-9]/g, '');
  const list = readOrders(); const o = list.find((x) => String(x.id) === id);
  if (!o) return sendJson(res, 404, { ok: false, error: 'الطلب غير موجود.' });
  const fc = await buildFileContent(o);
  if (!fc.count) return sendJson(res, 400, { ok: false, error: 'لا توجد ملفات قابلة للقراءة (PDF/صور/نص/PowerPoint/Word).' });
  const userContent = [{ type: 'text', text: 'لخّص المادة المرفقة في ملخص دراسي منظّم.' + (fc.text ? ('\n\nنص إضافي من المادة:\n' + fc.text) : '') }].concat(fc.blocks);
  try {
    const resp = await callAnthropic([{ role: 'user', content: userContent }]);
    const out = parseAgent(resp.content.map((c) => c.text || '').join(''));
    o.summary = { data: out.summary, turns: [{ role: 'assistant', text: out.reply }], updatedAt: new Date().toISOString() };
    writeOrders(list);
    console.log(`🤖 ملخص #${o.id} تولّد (${resp.usage.input_tokens}+${resp.usage.output_tokens} توكن)`);
    sendJson(res, 200, { ok: true, data: out.summary, reply: out.reply, usage: resp.usage });
  } catch (e) { sendJson(res, 500, { ok: false, error: 'تعذّر التوليد: ' + e.message }); }
}

// Admin: apply a chat edit to the current summary.
async function handleSummaryChat(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  if (!ANTHROPIC_API_KEY) return sendJson(res, 400, { ok: false, error: 'مفتاح الذكاء غير مضبوط على الخادم.' });
  const body = await readBody(req);
  const id = String(body.id || '').replace(/[^0-9]/g, '');
  const msg = String(body.message || '').slice(0, 2000).trim();
  if (!msg) return sendJson(res, 400, { ok: false, error: 'اكتب التعديل المطلوب.' });
  const list = readOrders(); const o = list.find((x) => String(x.id) === id);
  if (!o || !o.summary) return sendJson(res, 400, { ok: false, error: 'ولّد الملخص أولاً.' });
  const log = (o.summary.turns || []).slice(-8).map((t) => (t.role === 'user' ? 'المستخدم: ' : 'المساعد: ') + t.text).join('\n');
  const prompt = 'الملخص الحالي (JSON):\n' + JSON.stringify(o.summary.data) +
    (log ? ('\n\nسجل المحادثة السابق:\n' + log) : '') +
    '\n\nطلب المستخدم الجديد: ' + msg +
    '\n\nنفّذ الطلب وأعد JSON بالشكل المطلوب {"reply":...,"summary":...}.';
  try {
    const resp = await callAnthropic([{ role: 'user', content: prompt }]);
    const out = parseAgent(resp.content.map((c) => c.text || '').join(''));
    o.summary.data = out.summary;
    o.summary.turns = (o.summary.turns || []).concat([{ role: 'user', text: msg }, { role: 'assistant', text: out.reply }]);
    o.summary.updatedAt = new Date().toISOString();
    writeOrders(list);
    sendJson(res, 200, { ok: true, data: out.summary, reply: out.reply, usage: resp.usage });
  } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
}

// Admin: fetch the stored summary (to reopen the studio).
function handleSummaryGet(req, res, query) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const id = String(query.get('id') || '').replace(/[^0-9]/g, '');
  const o = readOrders().find((x) => String(x.id) === id);
  if (!o) return sendJson(res, 404, { ok: false, error: 'غير موجود.' });
  sendJson(res, 200, { ok: true, summary: o.summary || null });
}

// Admin maintenance: delete ALL orders + their files and reset the counter to 1001.
// Requires the admin key AND an explicit confirm flag to avoid accidental wipes.
async function handleClearOrders(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  if (body.confirm !== 'DELETE-ALL') return sendJson(res, 400, { ok: false, error: 'تأكيد مفقود.' });
  const before = readOrders().length;
  try {
    for (const e of fs.readdirSync(ORDERS_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && /^\d+$/.test(e.name)) {
        fs.rmSync(path.join(ORDERS_DIR, e.name), { recursive: true, force: true });
      }
    }
  } catch { /* dir may not exist yet */ }
  writeOrders([]);
  try { fs.writeFileSync(COUNTER_DB, JSON.stringify({ last: 1000 }), 'utf8'); } catch {}
  sendJson(res, 200, { ok: true, deleted: before });
}

// ---------- GET /api/order/track (public) ----------
// Look up an order by its number. Returns ONLY non-sensitive fields (status, service,
// date) — never the customer's name, contacts, notes, or files.
function handleTrackOrder(res, query) {
  const id = String(query.get('id') || '').replace(/[^0-9]/g, '');
  if (!id) return sendJson(res, 400, { ok: false, error: 'أدخل رقم الطلب.' });
  const o = readOrders().find((x) => String(x.id) === id);
  if (!o) return sendJson(res, 404, { ok: false, error: 'لا يوجد طلب بهذا الرقم. تأكّد من الرقم وحاول مرة أخرى.' });
  sendJson(res, 200, { ok: true, order: { id: o.id, status: o.status, service: o.service, createdAt: o.createdAt } });
}

// ---------- discount codes ----------
// Public: validate a code (used by the order form to show the discount live).
function handleDiscountCheck(res, query) {
  const d = findValidDiscount(query.get('code'));
  if (!d) return sendJson(res, 404, { ok: false, error: 'كود غير صالح أو منتهي الصلاحية.' });
  sendJson(res, 200, { ok: true, code: d.code, percent: d.percent });
}
// Admin: list all codes (with an `expired` flag).
function handleDiscountsList(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const now = Date.now();
  const discounts = readDiscounts().map((d) => Object.assign({}, d, { expired: d.expiresAt ? new Date(d.expiresAt).getTime() < now : false }));
  sendJson(res, 200, { ok: true, discounts });
}
// Admin: add or update a code. `days` > 0 sets an expiry; 0/empty means no expiry.
async function handleDiscountSave(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  const code = String(body.code || '').trim().toUpperCase();
  const percent = Math.round(Number(body.percent));
  const days = Number(body.days);
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'كود غير صالح (حروف/أرقام إنجليزية فقط، 2-32 خانة).' });
  if (!(percent >= 1 && percent <= 100)) return sendJson(res, 400, { ok: false, error: 'النسبة يجب أن تكون بين 1 و100.' });
  const expiresAt = (days && days > 0) ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const list = readDiscounts();
  const existing = list.find((x) => String(x.code).toUpperCase() === code);
  if (existing) { existing.code = code; existing.percent = percent; existing.expiresAt = expiresAt; }
  else { list.push({ code, percent, expiresAt, createdAt: new Date().toISOString() }); }
  writeDiscounts(list);
  sendJson(res, 200, { ok: true });
}
// Admin: delete a code.
async function handleDiscountDelete(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرّح.' });
  const body = await readBody(req);
  const code = String(body.code || '').trim().toUpperCase();
  writeDiscounts(readDiscounts().filter((x) => String(x.code).toUpperCase() !== code));
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
const STATIC_DENY = new Set(['admin-config.json', 'admin-config.example.json', 'work.json', 'settings.json', 'discounts.json', 'package.json', 'package-lock.json', 'serve.cjs']);
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
      const headers = { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
      // HTML must always be revalidated so dashboard/site updates show without a hard refresh.
      if (ext === '.html') headers['Cache-Control'] = 'no-cache, must-revalidate';
      res.writeHead(200, headers);
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
  if (req.method === 'POST' && urlPath === '/api/order/delete') return handleDeleteOrder(req, res);
  if (req.method === 'POST' && urlPath === '/api/order/deliverable') return handleUploadDeliverable(req, res);
  if (req.method === 'POST' && urlPath === '/api/order/deliverable/delete') return handleDeleteDeliverable(req, res);
  if (req.method === 'GET' && urlPath === '/api/deliverable') return handleDeliverableDownload(req, res, parsed.searchParams);
  if (req.method === 'POST' && urlPath === '/api/order/deliver') return handleDeliverOrder(req, res);
  if (req.method === 'POST' && urlPath === '/api/order/summary/generate') return handleSummaryGenerate(req, res);
  if (req.method === 'POST' && urlPath === '/api/order/summary/chat') return handleSummaryChat(req, res);
  if (req.method === 'GET' && urlPath === '/api/order/summary') return handleSummaryGet(req, res, parsed.searchParams);
  if (req.method === 'POST' && urlPath === '/api/orders/clear') return handleClearOrders(req, res);
  if (req.method === 'GET' && urlPath === '/api/order/track') return handleTrackOrder(res, parsed.searchParams);
  if (req.method === 'GET' && urlPath === '/api/discount/check') return handleDiscountCheck(res, parsed.searchParams);
  if (req.method === 'GET' && urlPath === '/api/discounts') return handleDiscountsList(req, res);
  if (req.method === 'POST' && urlPath === '/api/discounts/save') return handleDiscountSave(req, res);
  if (req.method === 'POST' && urlPath === '/api/discounts/delete') return handleDiscountDelete(req, res);
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
