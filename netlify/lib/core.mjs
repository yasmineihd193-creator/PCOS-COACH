// All notification-backend logic lives here, with its dependencies injected
// (getStore, webpush, env, now) so it can be tested end-to-end without Netlify.
import crypto from 'node:crypto';

export const LIMITS = { water: 12, supplements: 8, weighing: 3 };
export const DEFAULT_TZ = 'Europe/Paris';
const CATCH_UP_MINUTES = 10;   // late scheduler runs still deliver; never early
const SEND_LOG_MAX = 20;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const keyOf = (endpoint) => Buffer.from(endpoint).toString('base64url');
// When a push service says a subscription is gone (404/410) we delete it and leave a small note, so the app can
// tell the person "Push subscription needs to be renewed" instead of silently failing. The note holds no secrets.
async function markInvalid(getStore, key, status) {
  try { await getStore('push-meta').setJSON('invalid-' + key, { at: new Date().toISOString(), status: status || null }); } catch (e) {}
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch (e) { return DEFAULT_TZ; } };

// ---------- VAPID configuration ----------
// A bare email in VAPID_SUBJECT makes web-push throw, which would silently break every send.
export function normalizeSubject(raw, siteUrl) {
  const s = String(raw || '').trim();
  if (/^https?:\/\/\S+/i.test(s) || /^mailto:\S+@\S+/i.test(s)) return { subject: s, fixed: false };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { subject: 'mailto:' + s, fixed: true, note: 'VAPID_SUBJECT was a bare email; "mailto:" was added automatically.' };
  if (/^https:\/\/\S+/i.test(String(siteUrl || ''))) return { subject: siteUrl, fixed: true, note: 'VAPID_SUBJECT is missing or invalid; the site URL is being used instead.' };
  return { subject: 'mailto:reminders@example.com', fixed: true, note: 'VAPID_SUBJECT is missing or invalid; a placeholder is being used. Set it to mailto:you@yourmail.com.' };
}
const maskSubject = (s) => s.replace(/^(mailto:)[^@]*@/i, '$1***@');

export function vapidReport(env, clientKey) {
  const pub = env.VAPID_PUBLIC_KEY || '', priv = env.VAPID_PRIVATE_KEY || '';
  const subj = normalizeSubject(env.VAPID_SUBJECT, env.URL);
  let validPair = false, pairError = null;
  try {
    const e = crypto.createECDH('prime256v1');
    e.setPrivateKey(b64u(priv));
    validPair = e.getPublicKey().equals(b64u(pub));
    if (!validPair) pairError = 'VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY.';
  } catch (err) { pairError = 'The VAPID keys are missing or not valid P-256 keys.'; }
  return {
    publicSet: !!pub, privateSet: !!priv, subjectSet: !!env.VAPID_SUBJECT, subject: maskSubject(subj.subject), subjectFixed: subj.fixed,
    subjectNote: subj.note || null, validPair, pairError, serverKeyPrefix: pub.slice(0, 10),
    matchesApp: clientKey ? clientKey === pub : null,
  };
}

export function configureWebPush(webpush, env) {
  const r = vapidReport(env);
  if (!r.publicSet || !r.privateSet) return { ok: false, error: 'VAPID_PUBLIC_KEY and/or VAPID_PRIVATE_KEY are not set in the Netlify environment variables.' };
  if (!r.validPair) return { ok: false, error: r.pairError };
  try {
    webpush.setVapidDetails(normalizeSubject(env.VAPID_SUBJECT, env.URL).subject, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function errorDetail(err) {
  const statusCode = err && err.statusCode;
  let hint;
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) hint = 'The push service rejected the VAPID credentials. Check VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Netlify, make sure the public key matches the one built into the app, then redeploy.';
  else if (statusCode === 404 || statusCode === 410) hint = 'This device\u2019s push subscription has expired or was removed. Turn notifications off and on again in the app.';
  else if (statusCode === 413) hint = 'The message was too large for the push service.';
  else if (statusCode === 429) hint = 'The push service is rate limiting this server. It will be retried.';
  else if (statusCode >= 500) hint = 'The push service had a temporary problem. It will be retried.';
  else hint = 'The server could not reach the push service (network error).';
  return { statusCode: statusCode || null, message: (err && err.message) || String(err), body: String((err && err.body) || '').slice(0, 300), hint };
}

// ---------- reminders ----------
export function cleanReminders(input) {
  if (!Array.isArray(input)) return [];
  const byId = new Map();
  for (const r of input) {
    if (!r || typeof r.id !== 'string' || !LIMITS[r.category]) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '')) continue;
    const recurrence = ['daily', 'weekly', 'once'].includes(r.recurrence) ? r.recurrence : 'daily';
    const out = {
      id: r.id.slice(0, 64), category: r.category, label: String(r.label || '').slice(0, 24), time: r.time, recurrence,
      weekdays: Array.isArray(r.weekdays) ? [...new Set(r.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [],
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : null,
    };
    if (recurrence === 'weekly' && out.weekdays.length === 0) continue;
    if (recurrence === 'once' && !out.date) continue;
    byId.set(out.id, out);
  }
  const counts = {}, result = [];
  for (const r of byId.values()) { counts[r.category] = (counts[r.category] || 0) + 1; if (counts[r.category] <= LIMITS[r.category]) result.push(r); }
  return result;
}

export function zonedNow(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hh = String(parseInt(p.hour, 10) % 24).padStart(2, '0');
  return { minutes: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10), dateStr: `${p.year}-${p.month}-${p.day}`, weekday: WEEKDAYS[p.weekday], hhmm: `${hh}:${p.minute}` };
}
export function appliesToday(r, now) {
  if (r.recurrence === 'once') return r.date === now.dateStr;
  if (r.recurrence === 'weekly') return Array.isArray(r.weekdays) && r.weekdays.includes(now.weekday);
  return true;
}
export function isDue(r, now) {
  const [h, m] = String(r.time).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  const target = h * 60 + m;
  return now.minutes >= target && now.minutes < target + CATCH_UP_MINUTES;
}
export function messageFor(r) {
  const label = String(r.label || '').trim();
  const url = './index.html?action=' + ({ water: 'water', supplements: 'supplements', weighing: 'weighing' }[r.category] || '');
  if (r.category === 'water') return { body: '💧 Time to drink some water', url };
  if (r.category === 'weighing') return { body: '⚖️ Time to weigh yourself', url };
  return { body: label ? `💊 Time for your ${label.toLowerCase()} supplements` : '💊 Supplement reminder', url };
}
export function dueReminders(rec, date = new Date()) {
  const tz = rec.tz || DEFAULT_TZ;
  const now = zonedNow(tz, date);
  const log = rec.sentLog && rec.sentLog.date === now.dateStr ? rec.sentLog : { date: now.dateStr, sent: {} };
  const due = (rec.reminders || []).filter((r) => appliesToday(r, now) && isDue(r, now) && log.sent[r.id] !== r.time);
  return { due, sent: { ...(log.sent || {}) }, dateStr: now.dateStr };
}
export function nextDue(reminders, tz, date = new Date()) {
  const today = zonedNow(tz, date);
  let best = null;
  for (let d = 0; d <= 8; d++) {
    const n = d === 0 ? today : zonedNow(tz, new Date(date.getTime() + d * 86400000));
    for (const r of reminders) {
      if (!appliesToday(r, n)) continue;
      const [h, m] = r.time.split(':').map(Number);
      if (d === 0 && h * 60 + m < today.minutes) continue;
      const key = n.dateStr + ' ' + r.time;
      if (!best || key < best.key) best = { key, id: r.id, category: r.category, label: r.label, date: n.dateStr, time: r.time };
    }
  }
  return best;
}

// ---------- HTTP handlers ----------
async function readJson(req) { try { return await req.json(); } catch (e) { return null; } }

export async function handleSubscribe(req, deps) {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const body = await readJson(req);
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return json({ ok: false, error: 'Invalid push subscription' }, 400);
  const pub = deps.env.VAPID_PUBLIC_KEY;
  if (pub && body.clientKey && body.clientKey !== pub) {
    return json({ ok: false, error: 'vapid_key_mismatch', message: 'The public key built into the app does not match VAPID_PUBLIC_KEY on the server, so push services would reject every message. Set VAPID_PUBLIC_KEY in Netlify to the key from the README and redeploy.' }, 409);
  }
  try {
    const store = deps.getStore('push-subscriptions');
    const key = keyOf(sub.endpoint);
    const reminders = cleanReminders(body.reminders);
    let sentLog = null, sendLog = [];
    try { const ex = await store.get(key, { type: 'json' }); if (ex) { sentLog = ex.sentLog || null; sendLog = ex.sendLog || []; } } catch (e) {}
    await store.setJSON(key, { subscription: sub, tz: validTz(body.tz), reminders, updatedAt: deps.now().toISOString(), sentLog, sendLog });
    try { await deps.getStore('push-meta').delete('invalid-' + key); } catch (e) {}
    return json({ ok: true, count: reminders.length });
  } catch (e) {
    return json({ ok: false, error: 'storage_error', message: 'Could not save to Netlify Blobs: ' + (e && e.message) }, 500);
  }
}

export async function handleUnsubscribe(req, deps) {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const body = await readJson(req);
  if (!body || !body.endpoint) return json({ ok: false, error: 'Missing endpoint' }, 400);
  try { await deps.getStore('push-subscriptions').delete(keyOf(body.endpoint)); return json({ ok: true }); }
  catch (e) { return json({ ok: false, error: 'storage_error', message: e.message }, 500); }
}

export async function handleStatus(req, deps) {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const body = (await readJson(req)) || {};
  const now = deps.now();
  const out = { ok: true, serverTime: now.toISOString(), vapid: vapidReport(deps.env, body.clientKey), storage: { ok: false }, subscription: { stored: false }, scheduler: { lastRun: null }, sends: [] };
  try {
    const store = deps.getStore('push-subscriptions');
    const meta = deps.getStore('push-meta');
    const hb = await meta.get('heartbeat', { type: 'json' });
    out.storage = { ok: true };
    if (hb) out.scheduler = { lastRun: hb.lastRun, ageSeconds: Math.round((now - new Date(hb.lastRun)) / 1000), runs: hb.runs, lastResult: hb.lastResult || null, lastError: hb.lastError || null };
    if (body.endpoint) {
      const rec = await store.get(keyOf(body.endpoint), { type: 'json' });
      if (rec) {
        const tz = rec.tz || DEFAULT_TZ;
        out.subscription = { stored: true, tz, updatedAt: rec.updatedAt, reminders: (rec.reminders || []).length,
          water: (rec.reminders || []).filter((r) => r.category === 'water').length, ids: (rec.reminders || []).map((r) => r.id), nextDue: nextDue(rec.reminders || [], tz, now) };
        out.sends = (rec.sendLog || []).slice(-8);
      } else {
        try { const inv = await meta.get('invalid-' + keyOf(body.endpoint), { type: 'json' }); if (inv) out.subscription = { stored: false, invalidated: inv }; } catch (e) {}
      }
    }
  } catch (e) { out.storage = { ok: false, error: (e && e.message) || String(e) }; }
  return json(out);
}

async function appendSendLog(store, key, rec, entry) {
  const sendLog = [...(rec.sendLog || []), entry].slice(-SEND_LOG_MAX);
  rec.sendLog = sendLog;
  return sendLog;
}

export async function handleTestPush(req, deps) {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const body = await readJson(req);
  if (!body || !body.endpoint) return json({ ok: false, error: 'Missing endpoint' }, 400);
  const cfg = configureWebPush(deps.webpush, deps.env);
  if (!cfg.ok) return json({ ok: false, stage: 'vapid', message: cfg.error, hint: 'Fix the VAPID_* environment variables in Netlify, then redeploy.' }, 500);
  let store, rec;
  const key = keyOf(body.endpoint);
  try { store = deps.getStore('push-subscriptions'); rec = await store.get(key, { type: 'json' }); }
  catch (e) { return json({ ok: false, stage: 'storage', message: 'Netlify Blobs error: ' + e.message }, 500); }
  if (!rec || !rec.subscription) return json({ ok: false, stage: 'subscription', message: 'The server has no saved subscription for this device.', hint: 'Open the app once so it re-syncs, or turn notifications off and on again.' }, 404);
  const at = deps.now().toISOString();
  try {
    const res = await deps.webpush.sendNotification(rec.subscription, JSON.stringify({ title: 'PCOS Coach', body: '✅ Test notification — reminders can reach this device.', url: './index.html', tag: 'test' }), { TTL: 120, urgency: 'high' });
    await appendSendLog(store, key, rec, { id: 'test', category: 'test', at, ok: true, status: res && res.statusCode });
    await store.setJSON(key, rec);
    return json({ ok: true, statusCode: res && res.statusCode });
  } catch (e) {
    const d = errorDetail(e);
    if (d.statusCode === 404 || d.statusCode === 410) {
      try { await store.delete(key); await markInvalid(deps.getStore, key, d.statusCode); } catch (e2) {}
      return json({ ok: false, stage: 'push-service', ...d, invalidated: true }, 502);
    }
    try { await appendSendLog(store, key, rec, { id: 'test', category: 'test', at, ok: false, status: d.statusCode, error: d.message }); await store.setJSON(key, rec); } catch (e2) {}
    return json({ ok: false, stage: 'push-service', ...d }, 502);
  }
}

// ---------- the scheduler (runs every minute) ----------
async function writeHeartbeat(meta, now, result, lastError) {
  let prev = null;
  try { prev = await meta.get('heartbeat', { type: 'json' }); } catch (e) {}
  await meta.setJSON('heartbeat', { lastRun: now.toISOString(), runs: ((prev && prev.runs) || 0) + 1, lastResult: result, lastError: lastError || null });
}

export async function runScheduler(deps) {
  const now = deps.now();
  const result = { subscriptions: 0, due: 0, sent: 0, failed: 0, removed: 0, errors: [] };
  let meta;
  try {
    meta = deps.getStore('push-meta');
    const cfg = configureWebPush(deps.webpush, deps.env);
    if (!cfg.ok) { result.errors.push('VAPID configuration: ' + cfg.error); await writeHeartbeat(meta, now, result, cfg.error); return { ok: false, result }; }
    const store = deps.getStore('push-subscriptions');
    const { blobs } = await store.list();
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: 'json' });
      if (!rec || !rec.subscription || !Array.isArray(rec.reminders)) continue;
      result.subscriptions++;
      const { due, sent, dateStr } = dueReminders(rec, now);
      if (!due.length) continue;
      result.due += due.length;
      let stale = false;
      for (const r of due) {
        const msg = messageFor(r);
        try {
          const res = await deps.webpush.sendNotification(rec.subscription, JSON.stringify({ title: 'PCOS Coach', body: msg.body, url: msg.url, tag: r.id }), { TTL: 3600, urgency: 'high' });
          sent[r.id] = r.time; result.sent++;
          await appendSendLog(store, b.key, rec, { id: r.id, category: r.category, at: now.toISOString(), ok: true, status: res && res.statusCode });
        } catch (e) {
          const d = errorDetail(e);
          result.failed++; result.errors.push(`${r.category} ${r.time}: ${d.statusCode || 'network'} ${d.message}`.slice(0, 160));
          await appendSendLog(store, b.key, rec, { id: r.id, category: r.category, at: now.toISOString(), ok: false, status: d.statusCode, error: d.message });
          if (d.statusCode === 404 || d.statusCode === 410) stale = true;
          // permanent rejections are not retried every minute; transient ones (network, 429, 5xx) are
          if (d.statusCode && d.statusCode >= 400 && d.statusCode < 500 && d.statusCode !== 429) sent[r.id] = r.time;
        }
      }
      if (stale) { await store.delete(b.key); await markInvalid(deps.getStore, b.key, 410); result.removed++; }
      else await store.setJSON(b.key, { ...rec, sentLog: { date: dateStr, sent }, sendLog: rec.sendLog });
    }
    result.errors = result.errors.slice(0, 5);
    await writeHeartbeat(meta, now, result, null);
    return { ok: true, result };
  } catch (e) {
    result.errors.push(String((e && e.message) || e));
    try { if (meta) await writeHeartbeat(meta, now, result, String((e && e.message) || e)); } catch (e2) {}
    return { ok: false, result };
  }
}
