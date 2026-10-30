import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
const DB_URL = process.env.DATABASE_URL || '';
const DB_HOST = DB_URL ? new URL(DB_URL).hostname : '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const CATS = ["O'quv jarayoni", 'Ustozlar bilan', 'Infratuzilma', 'Yotoqxona', 'Boshqa'];
const STATUSES = ['yangi', 'qabul', 'jarayonda', 'hal'];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,x-admin-key,x-tg-init',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
const bad = (msg, status = 400) => json({ error: msg }, status);
// Neon SQL-over-HTTPS. Every statement is wrapped so rows come back as JSON.
const SQL_HOSTS = DB_HOST ? [DB_HOST.replace(/^[^.]+\./, 'api.'), DB_HOST] : [];
let sqlHost = null;
async function sqlFetch(host, body) {
  return fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Neon-Connection-String': DB_URL, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', 'content-type': 'application/json' },
    body,
  });
}
async function q(text, params = []) {
  const body = JSON.stringify({ query: `WITH t AS (${text}) SELECT coalesce(json_agg(t),'[]')::text FROM t`, params });
  let res, lastErr;
  for (const host of sqlHost ? [sqlHost] : SQL_HOSTS) {
    try {
      res = await sqlFetch(host, body);
      if (res.status === 404 && !sqlHost) { res = null; continue; }
      sqlHost = host;
      break;
    } catch (e) { lastErr = e; res = null; }
  }
  if (!res) throw lastErr || new Error('db unreachable');
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'db error');
  const rows = JSON.parse(data.rows[0][0]);
  return { rows, rowCount: rows.length };
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validUid = (u) => typeof u === 'string' && /^[a-zA-Z0-9_-]{3,64}$/.test(u);
const isAdmin = (req) => ADMIN_KEY && req.headers.get('x-admin-key') === ADMIN_KEY;

async function userExists(uid) {
  const r = await q('SELECT 1 x FROM users WHERE id=$1', [uid]);
  return r.rowCount > 0;
}

// ---- Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const SELF_URL = 'https://br-steep-haze-b9tabbet-api.compute.c-7.eu-central-1.aws.neon.tech';
const WEBHOOK_SECRET = BOT_TOKEN ? createHash('sha256').update('bk-hook:' + BOT_TOKEN).digest('hex').slice(0, 48) : '';

// Validates Telegram Mini App initData (HMAC per Telegram spec); returns the Telegram user or null.
function tgUser(initData) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = createHmac('sha256', secret).update(check).digest('hex');
    if (calc.length !== hash.length || !timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (Date.now() / 1000 - authDate > 7 * 86400) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch { return null; }
}

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

const START_TEXT = `Assalomu alaykum! Bu — BlackKnight Club, Millat Umidi talabalari ovozi.

• Universitetdagi muammoni yozing (anonim ham bo‘ladi)
• Boshqalarning murojaatiga ovoz bering
• Klub tadbirlariga yoziling
• Skill Swap: bilganingizni o‘rgating, keraklisini o‘rganing

Pastdagi tugmani bosing 👇`;

async function tgWebhook(req) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return bad('forbidden', 403);
  const upd = await req.json().catch(() => ({}));
  const msg = upd.message;
  if (msg && msg.chat && msg.chat.type === 'private') {
    const kb = WEBAPP_URL ? { inline_keyboard: [[{ text: 'BlackKnight’ni ochish', web_app: { url: WEBAPP_URL } }]] } : undefined;
    await tg('sendMessage', { chat_id: msg.chat.id, text: START_TEXT, reply_markup: kb });
  }
  return json({ ok: true });
}

async function tgSetup() {
  const out = {};
  out.webhook = await tg('setWebhook', { url: SELF_URL + '/tg/webhook', secret_token: WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true });
  if (WEBAPP_URL) out.menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Ochish', web_app: { url: WEBAPP_URL } } });
  out.commands = await tg('setMyCommands', { commands: [{ command: 'start', description: 'BlackKnight Club ilovasini ochish' }] });
  out.desc = await tg('setMyShortDescription', { short_description: 'Millat Umidi talabalari ovozi: muammolar, tadbirlar, Skill Swap.' });
  out.me = await tg('getMe', {});
  await q('INSERT INTO selftest (result) VALUES ($1) RETURNING 1 x', [JSON.stringify({ tgsetup: out })]).catch(() => {});
  return json(out);
}

async function route(req) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  let uid = url.searchParams.get('uid') || '';
  const body = m === 'GET' ? {} : await req.json().catch(() => ({}));

  // A valid Telegram identity always wins over a client-chosen uid.
  const tu = tgUser(req.headers.get('x-tg-init'));
  if (tu && tu.id) {
    uid = 'tg' + tu.id;
    body.uid = uid;
    if (!(await userExists(uid))) {
      const name = [tu.first_name, tu.last_name].filter(Boolean).join(' ').slice(0, 60) || tu.username || 'Talaba';
      await q('INSERT INTO users (id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [uid, name]);
    }
  }

  if (p === '/' || p === '/api/health') {
    const r = await q('SELECT 1 AS one');
    return json({ ok: r.rows[0].one === 1, name: 'BlackKnight API' });
  }

  if (p === '/api/admin/check' && m === 'GET') return json({ admin: !!isAdmin(req) });

  if (p === '/api/stats' && m === 'GET') {
    const r = await q(`SELECT count(*)::int total,
      count(*) FILTER (WHERE status IN ('qabul','jarayonda'))::int progress,
      count(*) FILTER (WHERE status='hal')::int done,
      count(*) FILTER (WHERE status='hal' AND resolved_at > date_trunc('month', now()))::int done_month
      FROM problems`);
    const u = await q('SELECT count(*)::int n FROM users');
    return json({ ...r.rows[0], members: u.rows[0].n });
  }

  // ---- me / profile
  if (p === '/api/me' && m === 'GET') {
    if (!validUid(uid)) return bad('uid kerak');
    const r = await q('SELECT * FROM users WHERE id=$1', [uid]);
    if (!r.rowCount) return json({ user: null });
    const s = await q(`SELECT
      (SELECT count(*) FROM problems WHERE author_id=$1)::int problems,
      (SELECT count(*) FROM votes WHERE user_id=$1)::int votes,
      (SELECT count(*) FROM rsvps WHERE user_id=$1)::int events`, [uid]);
    return json({ user: r.rows[0], stats: s.rows[0] });
  }
  if (p === '/api/me' && m === 'PUT') {
    const id = body.uid;
    if (!validUid(id)) return bad('uid kerak');
    const name = str(body.name, 60);
    if (!name) return bad('Ismingizni yozing');
    const interests = Array.isArray(body.interests)
      ? body.interests.map((x) => str(x, 30)).filter(Boolean).slice(0, 8) : [];
    const r = await q(`INSERT INTO users (id,name,major,year,interests,teach,learn) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET name=$2, major=$3, year=$4, interests=$5, teach=$6, learn=$7 RETURNING *`,
      [id, name, str(body.major, 80), str(body.year, 20), interests, str(body.teach, 80), str(body.learn, 80)]);
    return json({ user: r.rows[0] });
  }
  if (p === '/api/matches' && m === 'GET') {
    if (!validUid(uid)) return bad('uid kerak');
    const r = await q(`SELECT u.id, u.name, u.major, u.teach, u.learn FROM users u, users me
      WHERE me.id=$1 AND u.id<>me.id AND (
        (me.learn<>'' AND u.teach<>'' AND (u.teach ILIKE '%'||me.learn||'%' OR me.learn ILIKE '%'||u.teach||'%'))
        OR (me.teach<>'' AND u.learn<>'' AND (u.learn ILIKE '%'||me.teach||'%' OR me.teach ILIKE '%'||u.learn||'%')))
      LIMIT 20`, [uid]);
    return json({ matches: r.rows });
  }

  // ---- problems
  if (p === '/api/problems' && m === 'GET') {
    const tab = url.searchParams.get('tab') || 'top';
    const where = tab === 'done' ? "p.status='hal'" : tab === 'new' ? "p.status<>'hal'" : "p.status<>'hal'";
    const order = tab === 'new' ? 'p.created_at DESC' : tab === 'done' ? 'p.resolved_at DESC NULLS LAST' : 'votes DESC, p.created_at DESC';
    const r = await q(`SELECT p.id, p.title, p.body, p.category, p.status, p.created_at, p.anon,
      CASE WHEN p.anon THEN NULL ELSE u.name END author,
      (SELECT count(*) FROM votes v WHERE v.problem_id=p.id)::int votes,
      EXISTS(SELECT 1 FROM votes v WHERE v.problem_id=p.id AND v.user_id=$1) voted,
      (p.author_id=$1) mine
      FROM problems p LEFT JOIN users u ON u.id=p.author_id
      WHERE ${where} ORDER BY ${order} LIMIT 100`, [uid]);
    return json({ problems: r.rows });
  }
  if (p === '/api/problems' && m === 'POST') {
    if (!validUid(body.uid) || !(await userExists(body.uid))) return bad('Avval profilni to‘ldiring', 401);
    const title = str(body.title, 140);
    if (title.length < 5) return bad('Sarlavha juda qisqa');
    const category = CATS.includes(body.category) ? body.category : 'Boshqa';
    const recent = await q("SELECT count(*)::int n FROM problems WHERE author_id=$1 AND created_at > now() - interval '1 hour'", [body.uid]);
    if (recent.rows[0].n >= 5) return bad('Bir soatda 5 tadan ko‘p murojaat yuborib bo‘lmaydi', 429);
    const r = await q('INSERT INTO problems (title,body,category,anon,author_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [title, str(body.body, 2000), category, !!body.anon, body.uid]);
    await q('INSERT INTO votes VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [r.rows[0].id, body.uid]);
    return json({ id: r.rows[0].id }, 201);
  }
  let mm;
  if ((mm = p.match(/^\/api\/problems\/(\d+)\/vote$/)) && m === 'POST') {
    if (!validUid(body.uid) || !(await userExists(body.uid))) return bad('Avval profilni to‘ldiring', 401);
    const id = +mm[1];
    const del = await q('DELETE FROM votes WHERE problem_id=$1 AND user_id=$2 RETURNING 1 x', [id, body.uid]);
    if (!del.rowCount) await q('INSERT INTO votes VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [id, body.uid]);
    const c = await q('SELECT count(*)::int n FROM votes WHERE problem_id=$1', [id]);
    return json({ voted: !del.rowCount, votes: c.rows[0].n });
  }
  if ((mm = p.match(/^\/api\/problems\/(\d+)$/)) && m === 'PATCH') {
    if (!isAdmin(req)) return bad('Ruxsat yo‘q', 403);
    if (!STATUSES.includes(body.status)) return bad('Noto‘g‘ri holat');
    await q("UPDATE problems SET status=$1, resolved_at = CASE WHEN $1='hal' THEN now() ELSE NULL END WHERE id=$2 RETURNING 1 x", [body.status, +mm[1]]);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/problems\/(\d+)$/)) && m === 'DELETE') {
    if (!isAdmin(req)) return bad('Ruxsat yo‘q', 403);
    await q('DELETE FROM problems WHERE id=$1 RETURNING 1 x', [+mm[1]]);
    return json({ ok: true });
  }

  // ---- events
  if (p === '/api/events' && m === 'GET') {
    const r = await q(`SELECT e.*, (SELECT count(*) FROM rsvps r WHERE r.event_id=e.id)::int going,
      EXISTS(SELECT 1 FROM rsvps r WHERE r.event_id=e.id AND r.user_id=$1) joined
      FROM events e WHERE e.starts_at > now() - interval '3 hours' ORDER BY e.starts_at LIMIT 50`, [uid]);
    return json({ events: r.rows });
  }
  if (p === '/api/events' && m === 'POST') {
    if (!isAdmin(req)) return bad('Ruxsat yo‘q', 403);
    const title = str(body.title, 120);
    const starts = new Date(body.starts_at);
    if (!title || isNaN(starts)) return bad('Nom va sana kerak');
    const r = await q('INSERT INTO events (title,description,starts_at,place,capacity) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [title, str(body.description, 1000), starts.toISOString(), str(body.place, 80), Math.max(0, parseInt(body.capacity) || 0)]);
    return json({ id: r.rows[0].id }, 201);
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)$/)) && m === 'DELETE') {
    if (!isAdmin(req)) return bad('Ruxsat yo‘q', 403);
    await q('DELETE FROM events WHERE id=$1 RETURNING 1 x', [+mm[1]]);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)\/rsvp$/)) && m === 'POST') {
    if (!validUid(body.uid) || !(await userExists(body.uid))) return bad('Avval profilni to‘ldiring', 401);
    const id = +mm[1];
    const del = await q('DELETE FROM rsvps WHERE event_id=$1 AND user_id=$2 RETURNING 1 x', [id, body.uid]);
    if (!del.rowCount) {
      const e = await q('SELECT capacity, (SELECT count(*) FROM rsvps WHERE event_id=$1)::int going FROM events WHERE id=$1', [id]);
      if (!e.rowCount) return bad('Tadbir topilmadi', 404);
      if (e.rows[0].capacity && e.rows[0].going >= e.rows[0].capacity) return bad('Joylar tugagan', 409);
      await q('INSERT INTO rsvps VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [id, body.uid]);
    }
    return json({ joined: !del.rowCount });
  }

  return bad('Topilmadi', 404);
}

async function selftest() {
  const out = [];
  const uid = 'selftest_' + Date.now();
  const call = async (m, path, body, h = {}) => {
    const r = await route(new Request('http://x' + path, { method: m, headers: { 'content-type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined }));
    const j = await r.json();
    out.push([m, path.split('?')[0], r.status, JSON.stringify(j).slice(0, 300)]);
    return j;
  };
  try {
    await call('GET', '/api/health');
    await call('PUT', '/api/me', { uid, name: 'Selftest', teach: 'Python', learn: 'Ingliz tili', interests: ['Startaplar'] });
    const p = await call('POST', '/api/problems', { uid, title: 'Selftest muammosi', category: 'Infratuzilma', anon: true });
    await call('GET', '/api/problems?tab=top&uid=' + uid);
    await call('POST', `/api/problems/${p.id}/vote`, { uid });
    await call('PATCH', `/api/problems/${p.id}`, { status: 'hal' }, { 'x-admin-key': ADMIN_KEY });
    const e = await call('POST', '/api/events', { title: 'Selftest', starts_at: new Date(Date.now() + 864e5).toISOString(), capacity: 5 }, { 'x-admin-key': ADMIN_KEY });
    await call('POST', `/api/events/${e.id}/rsvp`, { uid });
    await call('GET', '/api/events?uid=' + uid);
    await call('GET', '/api/me?uid=' + uid);
    await call('GET', '/api/stats');
    await call('DELETE', `/api/problems/${p.id}`, null, { 'x-admin-key': ADMIN_KEY });
    await call('DELETE', `/api/events/${e.id}`, null, { 'x-admin-key': ADMIN_KEY });
    await q('DELETE FROM users WHERE id=$1 RETURNING 1 x', [uid]);
  } catch (err) { out.push(['ERR', String(err && err.stack || err)]); }
  await q('INSERT INTO selftest (result) VALUES ($1) RETURNING 1 x', [JSON.stringify({ host: sqlHost, out })]).catch(() => {});
  return json({ out });
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const path = new URL(req.url).pathname;
      if (path === '/__selftest') return await selftest();
      if (path === '/tg/webhook' && req.method === 'POST') return await tgWebhook(req);
      if (path.startsWith('/tg/setup')) {
        const key = path.split('/')[3] || new URL(req.url).searchParams.get('key');
        if (!ADMIN_KEY || key !== ADMIN_KEY) return bad('forbidden', 403);
        return await tgSetup();
      }
      return await route(req);
    } catch (e) {
      console.error(e);
      return bad('Server xatosi', 500);
    }
  },
};
