import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
const DB_URL = process.env.DATABASE_URL || '';
const DB_HOST = DB_URL ? new URL(DB_URL).hostname : '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const CATS = ["O'quv jarayoni", 'Ustozlar bilan', 'Infratuzilma', 'Yotoqxona', 'Boshqa'];
const STATUSES = ['yangi', 'qabul', 'jarayonda', 'hal'];
const KINDS = ['muammo', 'savol', 'kerak', 'elon'];

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

const START_TEXT = `Assalomu alaykum! Bu — Black Knight Team, Millat Umidi talabalarining o‘z platformasi.

Nega qo‘shilish kerak?

1️⃣ Ovozingiz eshitiladi. Kampusdagi muammoni yozing (anonim ham bo‘ladi). Ko‘p ovoz to‘plaganini jamoamiz ma’muriyatga olib chiqadi, natijani sizga xabar qilamiz.
2️⃣ Kerakli odamni topasiz. Kim nimani biladi — «Odamlar»da qidiring, bilim almashing.
3️⃣ Ritsarga aylanasiz. Post, ovoz va do‘st taklifi uchun ball. Profilini to‘ldirgan va @blackknightsp kanaliga obuna bo‘lgan birinchi 229 kishiga — raqamli «Birinchi ritsar» nishoni.

Boshlash — 1 daqiqa: ilovani oching, profilingizni to‘ldiring va bitta muammoga ovoz bering 👇`;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Target answers a contact request; on accept the requester gets a link to the target.
// Contact link: a direct chat when the peer has a @username, otherwise a relay through the bot.
const dmLink = (peer) => (peer.username ? `https://t.me/${peer.username}` : `https://t.me/${BOT_USERNAME}?start=dm_${peer.id.slice(2)}`);
const firstName = (n) => String(n || 'Talaba').trim().split(/\s+/)[0];
async function canContact(a, b) {
  if (a === b) return false;
  const r = await q(`SELECT 1 x FROM users u WHERE u.id=$2 AND (u.contact='open' OR EXISTS (SELECT 1 FROM contact_requests c WHERE c.status='accepted'
    AND ((c.from_id=$1 AND c.to_id=$2) OR (c.from_id=$2 AND c.to_id=$1))))`, [a, b]);
  return r.rowCount > 0;
}
async function answerRequest(id, targetUid, accept) {
  const r = await q(`UPDATE contact_requests SET status=$1, answered_at=now() WHERE id=$2 AND to_id=$3 AND status='pending'
    RETURNING from_id, to_id`, [accept ? 'accepted' : 'declined', id, targetUid]);
  if (!r.rowCount) return { ok: false, error: 'So‘rov topilmadi yoki allaqachon javob berilgan' };
  if (accept) {
    // Both sides get each other's contact: an @username with a button, or a tappable profile link.
    const rows = (await q('SELECT id, name, username FROM users WHERE id = ANY($1)', [[r.rows[0].from_id, targetUid]])).rows;
    const by = (id) => rows.find((x) => x.id === id) || { id, name: 'Talaba' };
    // The contact itself lives in the app (Profil → Tanishlarim); the bot only tells both sides.
    const send = (toId, other, head) => {
      const first = firstName(other.name);
      const kb = [[{ text: `✉️ ${first}ga yozish`, url: dmLink(other) }]];
      if (WEBAPP_URL) kb.push([{ text: 'Black Knight’ni ochish', web_app: { url: WEBAPP_URL } }]);
      return tg('sendMessage', { chat_id: toId.slice(2), parse_mode: 'HTML',
        text: `${head}\n\nPastdagi tugma orqali yozishingiz mumkin. Kontakt ilovada Profil → «Tanishlarim» bo‘limida ham turadi.`,
        reply_markup: { inline_keyboard: kb } }).catch(() => {});
    };
    const from = by(r.rows[0].from_id), to = by(targetUid);
    await send(from.id, to, `✅ <b>${esc(to.name)}</b> tanishish so‘rovingizni qabul qildi.`);
    await send(to.id, from, `🤝 Siz <b>${esc(from.name)}</b> bilan tanishdingiz.`);
  }
  return { ok: true, accepted: accept };
}

const CHANNEL = process.env.CHANNEL || '';
const BOT_USERNAME = 'blackknightsp_bot';
const KNIGHT_LIMIT = 229;
const MILESTONES = [5, 10, 25, 50, 100, 200];
const LEVELS = [{ name: 'Navkar', min: 0 }, { name: 'Ritsar', min: 100 }, { name: 'Qora ritsar', min: 300 }];
const notify = (uid, text) => (uid && uid.startsWith('tg') ? tg('sendMessage', { chat_id: uid.slice(2), text, parse_mode: 'HTML', reply_markup: openKb() }).catch(() => {}) : null);

// Points: 10 per post, 2 per vote from someone else, 15 per invited friend who opened the app.
async function scoreOf(uid) {
  const r = await q(`SELECT
    (SELECT count(*) FROM problems WHERE author_id=$1)::int posts,
    (SELECT count(*) FROM votes v JOIN problems p ON p.id=v.problem_id WHERE p.author_id=$1 AND v.user_id<>$1)::int votes_recv,
    (SELECT count(*) FROM referrals r JOIN users u ON u.id=r.user_id WHERE r.referrer_id=$1 AND r.credited)::int invites,
    (SELECT count(*) FROM referrals r JOIN users u ON u.id=r.user_id WHERE r.referrer_id=$1 AND NOT r.credited)::int invites_pending`, [uid]);
  const s = r.rows[0];
  const points = s.posts * 10 + s.votes_recv * 2 + s.invites * 15;
  let li = 0; LEVELS.forEach((l, i) => { if (points >= l.min) li = i; });
  const next = LEVELS[li + 1] || null;
  return { ...s, points, level: LEVELS[li].name, level_index: li, next_level: next ? next.name : null, next_at: next ? next.min : null, prev_at: LEVELS[li].min };
}

async function isSubscribed(uid) {
  if (!CHANNEL) return true;
  const r = await tg('getChatMember', { chat_id: CHANNEL, user_id: uid.slice(2) }).catch(() => null);
  return !!(r && r.ok && ['member', 'administrator', 'creator', 'restricted'].includes(r.result.status));
}

// First Knight badge: the first KNIGHT_LIMIT authors whose post earned a vote from someone else.
// Badge rule: a filled profile (major + an interest or skill) and a channel subscription.
const profileFilled = (u) => !!(u && u.major && u.major.trim() && ((u.interests || []).length || (u.teach || '').trim() || (u.learn || '').trim()));
async function tryAwardKnight(uid) {
  if (!uid || !uid.startsWith('tg')) return 'no-tg';
  const u = await q('SELECT knight_no, major, interests, teach, learn FROM users WHERE id=$1', [uid]);
  if (!u.rowCount) return 'no-user';
  if (u.rows[0].knight_no) return 'has';
  if (!profileFilled(u.rows[0])) return 'incomplete';
  if ((await q('SELECT count(*)::int n FROM users WHERE knight_no IS NOT NULL')).rows[0].n >= KNIGHT_LIMIT) return 'full';
  if (!(await isSubscribed(uid))) return 'not-subscribed';
  try {
    const r = await q(`UPDATE users SET knight_no=(SELECT coalesce(max(knight_no),0)+1 FROM users)
      WHERE id=$1 AND knight_no IS NULL AND (SELECT count(*) FROM users WHERE knight_no IS NOT NULL) < ${KNIGHT_LIMIT}
      RETURNING knight_no`, [uid]);
    if (!r.rowCount) return 'full';
    await notify(uid, `♞ <b>Tabriklaymiz!</b> Siz Black Knight'ning <b>Birinchi ritsari #${r.rows[0].knight_no}</b> bo‘ldingiz (${KNIGHT_LIMIT} tadan).\n\nOltin belgi endi profilingiz va postlaringizda ko‘rinadi.`);
    return 'awarded';
  } catch { return 'retry'; /* two awards raced for the same number; the next visit retries */ }
}

// Volunteer ladder: hours of service logged by the team, separate from the points ladder.
const VLEVELS = [{ name: 'Volontyor', min: 0 }, { name: 'Yordamchi', min: 10 }, { name: 'Fidoyi', min: 25 }, { name: 'Xizmat ustasi', min: 50 }];
const vlevel = (h) => {
  let i = 0;
  VLEVELS.forEach((l, k) => { if (h >= l.min) i = k; });
  const next = VLEVELS[i + 1];
  return { level: VLEVELS[i].name, next_level: next ? next.name : null, next_at: next ? next.min : null };
};
async function serviceOf(uid) {
  const t = await q(`SELECT coalesce(sum(hours),0)::float hours, count(*)::int entries, count(DISTINCT event_id)::int events
    FROM service_log WHERE user_id=$1`, [uid]);
  const s = t.rows[0];
  return { hours: s.hours, entries: s.entries, events: s.events, ...vlevel(s.hours) };
}

const openKb = () => (WEBAPP_URL ? { inline_keyboard: [[{ text: 'Black Knight’ni ochish', web_app: { url: WEBAPP_URL } }]] } : undefined);

// Sends the guide video. The first send uploads it by URL; Telegram's file_id is then cached and reused.
async function sendGuide(chatId) {
  const cached = (await q("SELECT value FROM settings WHERE key='guide_file_id'")).rows[0];
  const video = cached ? cached.value : (WEBAPP_URL ? WEBAPP_URL.replace(/\/$/, '') + '/qollanma.mp4' : '');
  if (video) {
    const r = await tg('sendVideo', { chat_id: chatId, video, caption: START_TEXT, supports_streaming: true, width: 1080, height: 1920, reply_markup: openKb() });
    if (r && r.ok) {
      const fid = r.result && r.result.video && r.result.video.file_id;
      if (fid && !cached) await q("INSERT INTO settings (key,value) VALUES ('guide_file_id',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now() RETURNING 1 x", [fid]);
      return;
    }
    if (cached) await q("DELETE FROM settings WHERE key='guide_file_id' RETURNING 1 x");
  }
  await tg('sendMessage', { chat_id: chatId, text: START_TEXT, reply_markup: openKb() });
}

async function tgWebhook(req) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return bad('forbidden', 403);
  const upd = await req.json().catch(() => ({}));
  const cb = upd.callback_query;
  if (cb && typeof cb.data === 'string' && cb.data.startsWith('rq:')) {
    const [, id, act] = cb.data.split(':');
    const res = await answerRequest(+id, 'tg' + cb.from.id, act === 'a');
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: res.ok ? (res.accepted ? 'Qabul qilindi' : 'Rad etildi') : res.error });
    if (res.ok && cb.message) {
      await tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      if (!res.accepted) await tg('sendMessage', { chat_id: cb.message.chat.id, text: 'So‘rov rad etildi. U bu haqda xabar olmaydi.' });
    }
    return json({ ok: true });
  }
  const msg = upd.message;
  if (msg && msg.chat && msg.chat.type === 'private') {
    const text = String(msg.text || '');
    const refm = text.match(/^\/start\s+ref_(\d+)/);
    if (refm && msg.from && String(msg.from.id) !== refm[1]) {
      const me = 'tg' + msg.from.id, refId = 'tg' + refm[1];
      const known = await q('SELECT 1 x FROM users WHERE id=$1', [me]);
      if (!known.rowCount) await q(`INSERT INTO referrals (user_id, referrer_id) SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM users WHERE id=$2)
        ON CONFLICT DO NOTHING RETURNING 1 x`, [me, refId]);
    }
    const me = 'tg' + msg.from.id;
    const dmm = text.match(/^\/start\s+dm_(\d+)/);
    if (dmm) {
      const peerId = 'tg' + dmm[1];
      const peer = (await q('SELECT id, name, username FROM users WHERE id=$1', [peerId])).rows[0];
      if (!peer || !(await canContact(me, peerId))) {
        await tg('sendMessage', { chat_id: msg.chat.id, text: 'Bu talabaga yozish uchun avval tanishish so‘rovi qabul qilinishi kerak.', reply_markup: openKb() });
      } else if (peer.username) {
        await tg('sendMessage', { chat_id: msg.chat.id, text: `${firstName(peer.name)} bilan yozishish:`, reply_markup: { inline_keyboard: [[{ text: `✉️ ${firstName(peer.name)}ga yozish`, url: `https://t.me/${peer.username}` }]] } });
      } else {
        await q(`INSERT INTO dm_sessions (user_id, peer_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET peer_id=$2, updated_at=now() RETURNING 1 x`, [me, peerId]);
        await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', text: `✉️ Endi shu yerga yozgan xabarlaringiz <b>${esc(peer.name)}</b>ga bot orqali yetkaziladi (matn, rasm, ovozli xabar).\n\nYozishishni tugatish: /stop` });
      }
      return json({ ok: true });
    }
    if (text.startsWith('/stop')) {
      await q('DELETE FROM dm_sessions WHERE user_id=$1 RETURNING 1 x', [me]);
      await tg('sendMessage', { chat_id: msg.chat.id, text: 'Yozishish to‘xtatildi.', reply_markup: openKb() });
      return json({ ok: true });
    }
    if (!text.startsWith('/')) {
      const ses = (await q(`SELECT peer_id FROM dm_sessions WHERE user_id=$1 AND updated_at > now() - interval '7 days'`, [me])).rows[0];
      if (ses && (await canContact(me, ses.peer_id))) {
        const sender = (await q('SELECT id, name, username FROM users WHERE id=$1', [me])).rows[0] || { id: me, name: 'Talaba' };
        const head = await tg('sendMessage', { chat_id: ses.peer_id.slice(2), parse_mode: 'HTML', text: `✉️ <b>${esc(sender.name)}</b> sizga yozdi:`,
          reply_markup: { inline_keyboard: [[{ text: '↩️ Javob berish', url: dmLink(sender) }]] } });
        const cp = await tg('copyMessage', { chat_id: ses.peer_id.slice(2), from_chat_id: msg.chat.id, message_id: msg.message_id });
        await q('UPDATE dm_sessions SET updated_at=now() WHERE user_id=$1 RETURNING 1 x', [me]);
        await tg('sendMessage', { chat_id: msg.chat.id, text: cp && cp.ok ? '✓ Yetkazildi' : 'Xabar yetkazilmadi: u botni to‘xtatgan bo‘lishi mumkin.' });
        return json({ ok: true });
      }
    }
    if (text.startsWith('/start') || text.startsWith('/qollanma')) await sendGuide(msg.chat.id);
    else await tg('sendMessage', { chat_id: msg.chat.id, text: 'Ilovani ochish uchun pastdagi tugmani bosing. Qo‘llanma videoni qayta ko‘rish: /qollanma', reply_markup: openKb() });
  }
  return json({ ok: true });
}

async function tgSetup() {
  const out = {};
  out.before = await tg('getWebhookInfo', {});
  out.webhook = await tg('setWebhook', { url: SELF_URL + '/tg/webhook', secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
  if (WEBAPP_URL) out.menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Ochish', web_app: { url: WEBAPP_URL } } });
  out.commands = await tg('setMyCommands', { commands: [{ command: 'start', description: 'Black Knight ilovasini ochish' }, { command: 'qollanma', description: 'Qo‘llanma video' }] });
  out.desc = await tg('setMyShortDescription', { short_description: 'Millat Umidi talabalari ovozi: muammolar, tadbirlar, Skill Swap.' });
  out.me = await tg('getMe', {});
  try { const r = await fetch(SELF_URL + '/api/health'); out.selfcall = r.status + ' ' + (await r.text()).slice(0, 100); } catch (e) { out.selfcall = 'ERR ' + e.message; }
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
    const name = [tu.first_name, tu.last_name].filter(Boolean).join(' ').slice(0, 60) || tu.username || 'Talaba';
    const uname = tu.username ? String(tu.username).toLowerCase().slice(0, 40) : null;
    // Creates the user on first visit; afterwards keeps only the Telegram username current.
    const photo = typeof tu.photo_url === 'string' && tu.photo_url.startsWith('https://') ? tu.photo_url.slice(0, 500) : null;
    const up = await q(`INSERT INTO users (id,name,username,photo_url) VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, photo_url=EXCLUDED.photo_url
      WHERE users.username IS DISTINCT FROM EXCLUDED.username OR users.photo_url IS DISTINCT FROM EXCLUDED.photo_url
      RETURNING (xmax = 0) AS inserted`, [uid, name, uname, photo]);
    if (up.rowCount && up.rows[0].inserted) {
      const ref = await q('SELECT referrer_id FROM referrals WHERE user_id=$1', [uid]);
      if (ref.rowCount) await notify(ref.rows[0].referrer_id, `👥 Do‘stingiz <b>${esc(name)}</b> Black Knight'ga qo‘shildi. U profilini to‘ldirsa, sizga +15 ball beriladi.`);
    }
  }

  // Admin = the server key (scripts) or a Telegram account listed in admins.
  let mm;
  let admin = isAdmin(req);
  if (!admin && tu && tu.id) admin = (await q('SELECT 1 x FROM admins WHERE user_id=$1', [uid])).rowCount > 0;
  // Leaders (◇): recognized rival teams — may post announcements and run events, nothing else.
  const leader = !admin && tu && tu.id ? (await q("SELECT 1 x FROM users WHERE id=$1 AND role='leader'", [uid])).rowCount > 0 : false;

  if (p === '/' || p === '/api/health') {
    const r = await q('SELECT 1 AS one');
    return json({ ok: r.rows[0].one === 1, name: 'BlackKnight API' });
  }

  if (p === '/api/admin/check' && m === 'GET') return json({ admin: !!admin });

  // ---- admin management (Telegram accounts)
  if (p === '/api/admins' && m === 'GET') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    const r = await q(`SELECT u.id, u.name, u.username, u.position, a.added_at FROM admins a JOIN users u ON u.id=a.user_id ORDER BY a.added_at`);
    return json({ admins: r.rows });
  }
  if (p === '/api/admins' && m === 'POST') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    const uname = str(body.username, 40).replace(/^@/, '').toLowerCase();
    if (!uname) return bad('Telegram username kiriting');
    const u = await q('SELECT id, name FROM users WHERE username=$1', [uname]);
    if (!u.rowCount) return bad(`@${uname} hali ilovani ochmagan. Avval u botga kirib, ilovani bir marta ochsin.`, 404);
    await q('INSERT INTO admins (user_id, added_by) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [u.rows[0].id, uid || 'key']);
    const pos = str(body.position, 60);
    if (pos) await q('UPDATE users SET position=$1 WHERE id=$2 RETURNING id', [pos, u.rows[0].id]);
    await notify(u.rows[0].id, `◆ Siz Black Knight jamoasiga qo‘shildingiz.${pos ? `\nVazifangiz: <b>${esc(pos)}</b>` : ''}\n\nMas’uliyat — sharaf. Omad!`);
    return json({ ok: true, name: u.rows[0].name, position: pos || null }, 201);
  }
  if ((mm = p.match(/^\/api\/admins\/([a-zA-Z0-9_-]+)$/)) && m === 'DELETE') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    const c = await q('SELECT count(*)::int n FROM admins');
    if (c.rows[0].n <= 1) return bad('Oxirgi adminni o‘chirib bo‘lmaydi');
    await q('DELETE FROM admins WHERE user_id=$1 RETURNING 1 x', [mm[1]]);
    return json({ ok: true });
  }

  if (p === '/api/stats' && m === 'GET') {
    const r = await q(`SELECT count(*)::int total,
      count(*) FILTER (WHERE status IN ('qabul','jarayonda'))::int progress,
      count(*) FILTER (WHERE status='hal')::int done,
      count(*) FILTER (WHERE status='hal' AND resolved_at > date_trunc('month', now()))::int done_month
      FROM problems WHERE kind='muammo'`);
    const u = await q('SELECT count(*)::int n FROM users');
    return json({ ...r.rows[0], members: u.rows[0].n });
  }

  // ---- me / profile
  if (p === '/api/me' && m === 'GET') {
    if (!validUid(uid)) return bad('uid kerak');
    const r = await q('SELECT * FROM users WHERE id=$1', [uid]);
    if (!r.rowCount) return json({ user: null });
    if (!r.rows[0].knight_no && tu && profileFilled(r.rows[0]) && (await tryAwardKnight(uid)) === 'awarded') r.rows[0] = (await q('SELECT * FROM users WHERE id=$1', [uid])).rows[0];
    const s = await q(`SELECT
      (SELECT count(*) FROM problems WHERE author_id=$1)::int problems,
      (SELECT count(*) FROM votes WHERE user_id=$1)::int votes,
      (SELECT count(*) FROM rsvps WHERE user_id=$1)::int events`, [uid]);
    const score = await scoreOf(uid);
    return json({ user: r.rows[0], stats: s.rows[0], score, service: await serviceOf(uid),
      team: (await q('SELECT 1 x FROM admins WHERE user_id=$1', [uid])).rowCount > 0, leader: r.rows[0].role === 'leader', knight_limit: KNIGHT_LIMIT,
      knights: (await q('SELECT count(*)::int n FROM users WHERE knight_no IS NOT NULL')).rows[0].n,
      ref_link: uid.startsWith('tg') ? `https://t.me/${BOT_USERNAME}?start=ref_${uid.slice(2)}` : null });
  }
  if (p === '/api/me' && m === 'PUT') {
    const id = body.uid;
    if (!validUid(id)) return bad('uid kerak');
    const name = str(body.name, 60);
    if (!name) return bad('Ismingizni yozing');
    const interests = Array.isArray(body.interests)
      ? body.interests.map((x) => str(x, 30)).filter(Boolean).slice(0, 8) : [];
    const contact = body.contact === 'open' ? 'open' : 'request';
    const r = await q(`INSERT INTO users (id,name,major,year,interests,teach,learn,contact) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET name=$2, major=$3, year=$4, interests=$5, teach=$6, learn=$7, contact=$8 RETURNING *`,
      [id, name, str(body.major, 80), str(body.year, 20), interests, str(body.teach, 80), str(body.learn, 80), contact]);
    const knight = tu ? await tryAwardKnight(id) : 'no-tg';
    // Invite points count only once the invited friend has a filled profile.
    if (profileFilled(r.rows[0])) {
      const cr = await q('UPDATE referrals SET credited=true WHERE user_id=$1 AND NOT credited RETURNING referrer_id', [id]);
      if (cr.rowCount) await notify(cr.rows[0].referrer_id, `👥 Do‘stingiz <b>${esc(name)}</b> profilini to‘ldirdi — sizga <b>+15 ball</b>!`);
    }
    const user = knight === 'awarded' ? (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0] : r.rows[0];
    return json({ user, knight });
  }
  // ---- people directory and contact requests
  if (p === '/api/people' && m === 'GET') {
    const term = str(url.searchParams.get('q') || '', 60).replace(/^@/, '');
    const r = await q(`SELECT u.id, u.name, u.major, u.year, u.interests, u.teach, u.learn, u.photo_url, u.knight_no, u.title, u.role, u.position, EXISTS(SELECT 1 FROM admins a WHERE a.user_id=u.id) team
      FROM users u WHERE u.id NOT LIKE 'selftest%' AND u.id<>$1
      AND ($2='' OR u.name ILIKE '%'||$2||'%' OR u.username ILIKE '%'||$2||'%' OR u.major ILIKE '%'||$2||'%'
           OR u.teach ILIKE '%'||$2||'%' OR array_to_string(u.interests,' ') ILIKE '%'||$2||'%')
      ORDER BY u.created_at DESC LIMIT 60`, [uid, term]);
    return json({ people: r.rows });
  }
  if ((mm = p.match(/^\/api\/people\/([a-zA-Z0-9_-]+)$/)) && m === 'GET') {
    const r = await q(`SELECT u.id, u.name, u.major, u.year, u.interests, u.teach, u.learn, u.photo_url, u.contact, u.knight_no, u.title, u.role, u.position, EXISTS(SELECT 1 FROM admins a WHERE a.user_id=u.id) team,
      u.username, (u.id LIKE 'tg%') tg,
      (SELECT status FROM contact_requests WHERE from_id=$2 AND to_id=u.id) out_status,
      (SELECT json_build_object('id', id, 'status', status) FROM contact_requests WHERE from_id=u.id AND to_id=$2) incoming
      FROM users u WHERE u.id=$1`, [mm[1], uid]);
    if (!r.rowCount) return bad('Talaba topilmadi', 404);
    const u = r.rows[0];
    const inc = u.incoming;
    // Contact opens when the person allows everyone, or a request between the two was accepted.
    const canWrite = u.tg && u.id !== uid && (u.contact === 'open' || u.out_status === 'accepted' || (inc && inc.status === 'accepted'));
    const relation = u.id === uid ? 'me' : canWrite ? 'open' : inc && inc.status === 'pending' ? 'incoming'
      : u.out_status ? 'pending' : !u.tg ? 'unavailable' : 'none';
    return json({ person: { position: u.team || u.role === 'leader' ? u.position : null, role: u.role, team: u.team, service: await serviceOf(u.id), title: u.title, knight_no: u.knight_no, id: u.id, name: u.name, major: u.major, year: u.year, interests: u.interests, teach: u.teach, learn: u.learn,
      photo_url: u.photo_url, relation, username: canWrite ? u.username : null, request_id: inc ? inc.id : null } });
  }
  if ((mm = p.match(/^\/api\/people\/([a-zA-Z0-9_-]+)\/write$/)) && m === 'POST') {
    // For people without a public @username: the bot sends the requester a tappable link to them.
    if (!tu) return bad('Bu amal faqat Telegram ichida ishlaydi', 401);
    const r = await q(`SELECT u.id, u.name, u.contact, u.username FROM users u WHERE u.id=$1`, [mm[1]]);
    if (!r.rowCount || !r.rows[0].id.startsWith('tg')) return bad('Talaba topilmadi', 404);
    const t = r.rows[0];
    const ok = t.contact === 'open' || (await q(`SELECT 1 x FROM contact_requests WHERE status='accepted' AND
      ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1))`, [uid, t.id])).rowCount > 0;
    if (!ok) return bad('Avval tanishish so‘rovi yuboring', 403);
    await tg('sendMessage', { chat_id: tu.id, parse_mode: 'HTML',
      text: `${esc(t.name)} bilan bog‘lanish: <a href="tg://user?id=${t.id.slice(2)}">profilini ochish</a>` });
    return json({ ok: true });
  }
  if (p === '/api/requests' && m === 'GET') {
    const r = await q(`SELECT c.id, c.note, c.created_at, u.id user_id, u.name, u.major, u.year, u.photo_url
      FROM contact_requests c JOIN users u ON u.id=c.from_id WHERE c.to_id=$1 AND c.status='pending' ORDER BY c.created_at DESC`, [uid]);
    return json({ incoming: r.rows });
  }
  if (p === '/api/requests' && m === 'POST') {
    if (!tu) return bad('Tanishish so‘rovi faqat Telegram ichida yuboriladi', 401);
    const to = str(body.to, 64);
    if (!to.startsWith('tg') || to === uid) return bad('Bu talabaga so‘rov yuborib bo‘lmaydi');
    const day = await q(`SELECT count(*)::int n FROM contact_requests WHERE from_id=$1 AND created_at > now() - interval '1 day'`, [uid]);
    if (day.rows[0].n >= 15) return bad('Bir kunda 15 tadan ko‘p so‘rov yuborib bo‘lmaydi', 429);
    const note = str(body.note, 200);
    const ins = await q(`INSERT INTO contact_requests (from_id,to_id,note) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM users WHERE id=$2)
      ON CONFLICT (from_id,to_id) DO NOTHING RETURNING id`, [uid, to, note]);
    if (!ins.rowCount) return json({ ok: true, already: true });
    const me = (await q('SELECT name, major, year FROM users WHERE id=$1', [uid])).rows[0] || {};
    const who = [me.major, me.year && me.year + '-kurs'].filter(Boolean).join(', ');
    await tg('sendMessage', { chat_id: to.slice(2), parse_mode: 'HTML',
      text: `🤝 <b>${esc(me.name || 'Talaba')}</b>${who ? ' (' + esc(who) + ')' : ''} siz bilan tanishmoqchi.${note ? '\n\n«' + esc(note) + '»' : ''}\n\nRozi bo‘lsangiz, u sizga Telegram'da yoza oladi.`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Qabul qilish', callback_data: `rq:${ins.rows[0].id}:a` }, { text: 'Rad etish', callback_data: `rq:${ins.rows[0].id}:d` }]] },
    }).catch(() => {});
    return json({ ok: true }, 201);
  }
  if ((mm = p.match(/^\/api\/requests\/(\d+)$/)) && m === 'POST') {
    if (!tu) return bad('Bu amal faqat Telegram ichida ishlaydi', 401);
    const res = await answerRequest(+mm[1], uid, body.action === 'accept');
    return res.ok ? json(res) : bad(res.error, 404);
  }

  if (p === '/api/contacts' && m === 'GET') {
    if (!validUid(uid)) return bad('uid kerak');
    const r = await q(`SELECT u.id, u.name, u.username, u.major, u.photo_url, c.answered_at
      FROM contact_requests c JOIN users u ON u.id = CASE WHEN c.from_id=$1 THEN c.to_id ELSE c.from_id END
      WHERE c.status='accepted' AND (c.from_id=$1 OR c.to_id=$1) ORDER BY c.answered_at DESC NULLS LAST LIMIT 100`, [uid]);
    return json({ contacts: r.rows });
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

  // ---- service log (xizmat daftari): only the team writes it, anyone can read it
  if ((mm = p.match(/^\/api\/service\/([a-zA-Z0-9_-]+)$/)) && m === 'GET') {
    const r = await q(`SELECT s.id, s.hours::float hours, s.note, s.created_at, e.title event_title
      FROM service_log s LEFT JOIN events e ON e.id=s.event_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 50`, [mm[1]]);
    return json({ summary: await serviceOf(mm[1]), entries: r.rows, can_edit: !!admin });
  }
  if (p === '/api/service' && m === 'POST') {
    if (!admin) return bad('Xizmat daftariga faqat jamoa yozadi', 403);
    const target = str(body.user_id, 64);
    const hours = Math.round(parseFloat(body.hours) * 2) / 2;
    const note = str(body.note, 200);
    if (!(hours > 0 && hours <= 24)) return bad('Soat 0.5 dan 24 gacha bo‘lsin');
    if (note.length < 3) return bad('Nima ish qilinganini yozing');
    const u = await q('SELECT id, role FROM users WHERE id=$1', [target]);
    if (!u.rowCount) return bad('Talaba topilmadi', 404);
    const before = await serviceOf(target);
    const eid = parseInt(body.event_id) || null;
    await q('INSERT INTO service_log (user_id,hours,note,event_id,added_by) VALUES ($1,$2,$3,(SELECT id FROM events WHERE id=$4),$5) RETURNING id',
      [target, hours, note, eid, uid || 'key']);
    if (!u.rows[0].role) await q("UPDATE users SET role='volunteer' WHERE id=$1 RETURNING 1 x", [target]);
    const after = await serviceOf(target);
    let msg = `🤝 Xizmat daftaringizga <b>+${hours} soat</b> yozildi:\n«${esc(note)}»\n\nJami: <b>${after.hours} soat</b>. Rahmat!`;
    if (after.level !== before.level) msg += `\n\n🎖 Tabriklaymiz! Endi siz — <b>${after.level}</b>.`;
    await notify(target, msg);
    return json({ ok: true, summary: after }, 201);
  }
  if ((mm = p.match(/^\/api\/service\/entry\/(\d+)$/)) && m === 'DELETE') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    await q('DELETE FROM service_log WHERE id=$1 RETURNING 1 x', [+mm[1]]);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/people\/([a-zA-Z0-9_-]+)\/role$/)) && m === 'POST') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    const role = body.role === 'volunteer' ? 'volunteer' : null;
    const r = await q('UPDATE users SET role=$1 WHERE id=$2 RETURNING id', [role, mm[1]]);
    if (!r.rowCount) return bad('Talaba topilmadi', 404);
    if (role) await notify(mm[1], '✧ Siz Black Knight <b>volontyori</b> sifatida belgilandingiz. Xizmatlaringiz endi daftaringizda yozib boriladi. Xush kelibsiz!');
    return json({ ok: true, role });
  }
  // Pagon: a team member's responsibility, set by the team; replaces points for them.
  if ((mm = p.match(/^\/api\/people\/([a-zA-Z0-9_-]+)\/position$/)) && m === 'POST') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    const pos = str(body.position, 60);
    const r = await q(`UPDATE users SET position=$1 WHERE id=$2 AND EXISTS (SELECT 1 FROM admins WHERE user_id=$2) RETURNING id`, [pos || null, mm[1]]);
    if (!r.rowCount) return bad('Mas’uliyat faqat jamoa a’zosiga beriladi', 404);
    if (pos) await notify(mm[1], `◆ Sizga jamoada mas’uliyat berildi:\n<b>${esc(pos)}</b>\n\nMas’uliyat — sharaf. Omad!`);
    return json({ ok: true, position: pos || null });
  }
  if ((mm = p.match(/^\/api\/people\/([a-zA-Z0-9_-]+)\/leader$/)) && m === 'POST') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    const name = str(body.name, 60);
    if ((await q('SELECT 1 x FROM admins WHERE user_id=$1', [mm[1]])).rowCount) return bad('Jamoa a’zosiga ◇ belgisi berilmaydi');
    const r = name
      ? await q("UPDATE users SET role='leader', position=$1 WHERE id=$2 RETURNING id", [name, mm[1]])
      : await q("UPDATE users SET role=NULL, position=NULL WHERE id=$1 AND role='leader' RETURNING id", [mm[1]]);
    if (!r.rowCount) return bad('Talaba topilmadi', 404);
    if (name) await notify(mm[1], `◇ Siz Black Knight platformasida <b>${esc(name)}</b> sifatida tan olindingiz.\n\nEndi ilovada e’lon joylashingiz va tadbir qo‘shishingiz mumkin. Talabalar ovozi — hammamizniki.`);
    return json({ ok: true });
  }
  if (p === '/api/volunteers' && m === 'GET') {
    const r = await q(`SELECT u.id, u.name, u.major, u.photo_url, coalesce(sum(s.hours),0)::float hours, count(s.id)::int entries
      FROM users u LEFT JOIN service_log s ON s.user_id=u.id
      WHERE u.role='volunteer' AND u.id NOT LIKE 'selftest%' GROUP BY u.id ORDER BY hours DESC, u.name LIMIT 200`);
    return json({ volunteers: r.rows.map((v) => ({ ...v, level: vlevel(v.hours).level })) });
  }

  // ---- problems
  if (p === '/api/problems' && m === 'GET') {
    const tab = url.searchParams.get('tab') || 'top';
    const kind = KINDS.includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : '';
    let where = tab === 'done' ? "p.status='hal'" : "p.status<>'hal'";
    if (kind) where += ` AND p.kind='${kind}'`;
    const order = tab === 'new' ? 'p.created_at DESC' : tab === 'done' ? 'p.resolved_at DESC NULLS LAST' : 'votes DESC, p.created_at DESC';
    const r = await q(`SELECT p.id, p.kind, p.title, p.body, p.category, p.status, p.created_at, p.anon,
      CASE WHEN p.anon THEN NULL ELSE u.name END author, CASE WHEN p.anon THEN NULL ELSE u.knight_no END author_knight, CASE WHEN p.anon THEN NULL ELSE u.title END author_title,
      CASE WHEN p.anon THEN NULL ELSE u.role END author_role, CASE WHEN p.anon THEN NULL ELSE u.position END author_position, (NOT p.anon AND EXISTS(SELECT 1 FROM admins a WHERE a.user_id=p.author_id)) author_team,
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
    const kind = KINDS.includes(body.kind) ? body.kind : 'muammo';
    if (kind === 'elon' && !admin && !leader) return bad('E’lonni faqat adminlar va ◇ yetakchilar joylay oladi', 403);
    const category = kind === 'muammo' ? (CATS.includes(body.category) ? body.category : 'Boshqa') : '';
    // "Kerak" posts need a real name so people can respond; announcements are signed by the club.
    const anon = (kind === 'muammo' || kind === 'savol') && !!body.anon;
    const recent = await q("SELECT count(*)::int n FROM problems WHERE author_id=$1 AND created_at > now() - interval '1 hour'", [body.uid]);
    if (recent.rows[0].n >= 5 && !admin) return bad('Bir soatda 5 tadan ko‘p post yozib bo‘lmaydi', 429);
    const r = await q('INSERT INTO problems (title,body,category,anon,author_id,kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [title, str(body.body, 2000), category, anon, body.uid, kind]);
    await q('INSERT INTO votes VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [r.rows[0].id, body.uid]);
    return json({ id: r.rows[0].id }, 201);
  }
  if ((mm = p.match(/^\/api\/problems\/(\d+)\/vote$/)) && m === 'POST') {
    if (!validUid(body.uid) || !(await userExists(body.uid))) return bad('Avval profilni to‘ldiring', 401);
    const id = +mm[1];
    const del = await q('DELETE FROM votes WHERE problem_id=$1 AND user_id=$2 RETURNING 1 x', [id, body.uid]);
    if (!del.rowCount) await q('INSERT INTO votes VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1 x', [id, body.uid]);
    const c = await q('SELECT count(*)::int n FROM votes WHERE problem_id=$1', [id]);
    const n = c.rows[0].n;
    if (!del.rowCount) {
      const pr = (await q('SELECT author_id, title, kind, notified_votes FROM problems WHERE id=$1', [id])).rows[0];
      if (pr && pr.author_id && pr.author_id !== body.uid) {
        const hit = MILESTONES.filter((x) => x <= n).pop();
        if (hit && hit > pr.notified_votes) {
          await q('UPDATE problems SET notified_votes=$1 WHERE id=$2 AND notified_votes<$1 RETURNING 1 x', [hit, id]);
          await notify(pr.author_id, `📣 «${esc(pr.title)}» posti <b>${hit} ta ovoz</b> to‘pladi!${pr.kind === 'muammo' ? ' Muammo ko‘pchilikni qiynayotgani ko‘rinib turibdi.' : ''}`);
        }
        await tryAwardKnight(pr.author_id);
      }
    }
    return json({ voted: !del.rowCount, votes: n });
  }
  if ((mm = p.match(/^\/api\/problems\/(\d+)$/)) && m === 'PATCH') {
    if (!admin) return bad('Ruxsat yo‘q', 403);
    if (!STATUSES.includes(body.status)) return bad('Noto‘g‘ri holat');
    const up = await q("UPDATE problems SET status=$1, resolved_at = CASE WHEN $1='hal' THEN now() ELSE NULL END WHERE id=$2 RETURNING author_id, title", [body.status, +mm[1]]);
    if (up.rowCount) {
      const labels = { yangi: 'Yangi', qabul: 'Qabul qilindi 📥', jarayonda: 'Jarayonda ⚙️', hal: 'Hal qilindi ✅' };
      const extra = body.status === 'hal' ? '\n\nRahmat! Ovozingiz natija berdi.' : '';
      await notify(up.rows[0].author_id, `Murojaatingiz holati yangilandi:\n«${esc(up.rows[0].title)}»\n\n<b>${labels[body.status]}</b>${extra}`);
    }
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/problems\/(\d+)$/)) && m === 'DELETE') {
    if (!admin && !leader) return bad('Ruxsat yo‘q', 403);
    const d = await q("DELETE FROM problems WHERE id=$1 AND ($2 OR (author_id=$3 AND kind='elon')) RETURNING 1 x", [+mm[1], !!admin, uid]);
    if (!d.rowCount) return bad('Faqat o‘zingizning e’loningizni o‘chira olasiz', 403);
    return json({ ok: true });
  }

  // ---- events
  if (p === '/api/events' && m === 'GET') {
    const r = await q(`SELECT e.*, (SELECT count(*) FROM rsvps r WHERE r.event_id=e.id)::int going,
      (SELECT json_build_object('name', u.name, 'role', u.role, 'position', u.position) FROM users u WHERE u.id=e.created_by AND u.role='leader') organizer,
      (e.created_by=$1) mine,
      EXISTS(SELECT 1 FROM rsvps r WHERE r.event_id=e.id AND r.user_id=$1) joined
      FROM events e WHERE e.starts_at > now() - interval '3 hours' ORDER BY e.starts_at LIMIT 50`, [uid]);
    return json({ events: r.rows });
  }
  if (p === '/api/events' && m === 'POST') {
    if (!admin && !leader) return bad('Tadbirni adminlar va ◇ yetakchilar qo‘sha oladi', 403);
    const title = str(body.title, 120);
    const starts = new Date(body.starts_at);
    if (!title || isNaN(starts)) return bad('Nom va sana kerak');
    const r = await q('INSERT INTO events (title,description,starts_at,place,capacity,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [title, str(body.description, 1000), starts.toISOString(), str(body.place, 80), Math.max(0, parseInt(body.capacity) || 0), uid || 'key']);
    return json({ id: r.rows[0].id }, 201);
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)$/)) && m === 'DELETE') {
    if (!admin && !leader) return bad('Ruxsat yo‘q', 403);
    const d = await q('DELETE FROM events WHERE id=$1 AND ($2 OR created_by=$3) RETURNING 1 x', [+mm[1], !!admin, uid]);
    if (!d.rowCount) return bad('Faqat o‘zingiz qo‘shgan tadbirni o‘chira olasiz', 403);
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
    const sv = await call('POST', '/api/problems', { uid, title: 'Selftest savoli', kind: 'savol' });
    await call('GET', '/api/problems?tab=new&kind=savol&uid=' + uid);
    await call('DELETE', `/api/problems/${sv.id}`, null, { 'x-admin-key': ADMIN_KEY });
    await call('POST', `/api/problems/${p.id}/vote`, { uid });
    await call('PATCH', `/api/problems/${p.id}`, { status: 'hal' }, { 'x-admin-key': ADMIN_KEY });
    const e = await call('POST', '/api/events', { title: 'Selftest', starts_at: new Date(Date.now() + 864e5).toISOString(), capacity: 5 }, { 'x-admin-key': ADMIN_KEY });
    await call('POST', `/api/events/${e.id}/rsvp`, { uid });
    await call('GET', '/api/events?uid=' + uid);
    await call('GET', '/api/me?uid=' + uid);
    await call('GET', '/api/people?q=Self&uid=x' );
    await call('GET', `/api/people/${uid}?uid=${uid}`);
    await call('POST', '/api/service', { user_id: uid, hours: 2, note: 'Selftest xizmati' }, { 'x-admin-key': ADMIN_KEY });
    await call('POST', '/api/service', { user_id: uid, hours: 9, note: 'Selftest ikkinchi' }, { 'x-admin-key': ADMIN_KEY });
    await call('POST', '/api/service', { user_id: uid, hours: 1, note: 'ruxsatsiz' });
    const sv2 = await call('GET', `/api/service/${uid}`);
    if (sv2.entries && sv2.entries[0]) await call('DELETE', `/api/service/entry/${sv2.entries[0].id}`, null, { 'x-admin-key': ADMIN_KEY });
    await call('GET', '/api/volunteers');
    await call('POST', `/api/people/${uid}/position`, { position: 'Test' }, { 'x-admin-key': ADMIN_KEY });
    await call('POST', `/api/people/${uid}/role`, { role: null }, { 'x-admin-key': ADMIN_KEY });
    await call('GET', '/api/requests?uid=' + uid);
    await call('POST', '/api/requests', { uid, to: 'tg1' });
    await call('GET', '/api/stats');
    // Relay: two fake Telegram users with an accepted request; /start dm_ then a text message.
    const A = 'tg990000001', B = 'tg990000002';
    await q("INSERT INTO users (id,name) VALUES ($1,'Selftest A'),($2,'Selftest B') ON CONFLICT DO NOTHING RETURNING 1 x", [A, B]);
    await q("INSERT INTO contact_requests (from_id,to_id,status) VALUES ($1,$2,'accepted') ON CONFLICT DO NOTHING RETURNING 1 x", [A, B]);
    const hook = async (text) => {
      const r = await tgWebhook(new Request('http://x/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        body: JSON.stringify({ message: { message_id: 1, chat: { id: 990000001, type: 'private' }, from: { id: 990000001 }, text } }) }));
      out.push(['HOOK', text, r.status]);
    };
    await hook('/start dm_990000002');
    out.push(['SESSION', (await q('SELECT peer_id FROM dm_sessions WHERE user_id=$1', [A])).rows]);
    await hook('Salom');
    await hook('/stop');
    out.push(['SESSION_AFTER_STOP', (await q('SELECT count(*)::int n FROM dm_sessions WHERE user_id=$1', [A])).rows]);
    await q('DELETE FROM contact_requests WHERE from_id=$1 RETURNING 1 x', [A]);
    await q('DELETE FROM users WHERE id = ANY($1) RETURNING 1 x', [[A, B]]);
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
