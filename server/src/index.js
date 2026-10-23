// 향수 최저가 — 재입고 알림 서버 (Cloudflare Workers + D1), 여러 사용자용
//
// 사용자(확장 프로그램 사용자)가 직접 하는 일 — 모두 확장 화면에서:
//   - 처음 쓸 때 기기별로 자동 가입 (접속 키를 받아 기기에 저장)
//   - 텔레그램 연결: 버튼 → 텔레그램 앱에서 "시작" 한 번
//   - 이메일 등록: 주소 입력 → 받은 메일의 인증 링크 클릭
//   - 품절 상품에 🔔 → 1분마다 재고 확인 → 재입고 즉시 텔레그램·이메일
//
// 운영자가 한 번 하는 일: setup.sh (서버 설치, 봇 토큰·Resend 키 등록)
//
// 비밀값 (wrangler secret put …):
//   TELEGRAM_BOT_TOKEN  @BotFather 에서 받은 봇 토큰
//   RESEND_API_KEY      Resend API 키
//   EMAIL_FROM          (도메인 인증 후) 보내는 주소. 예: "향수 최저가 <alert@내도메인.com>"
//                       없으면 onboarding@resend.dev 로 보내며, 이때는 Resend 가입 메일로만 발송 가능
// 선택 값 (wrangler.toml [vars]): MAX_PER_USER (사용자당 알림 수, 기본 30)

// ── 무료 요금제 한도 안에서 돌도록 맞춘 값 ──
// Workers Free: 실행 한 번에 외부 요청 50개, CPU 10ms, 크론 최소 1분
const MAX_CHECKS_PER_RUN = 25;   // 1분에 확인하는 상품 주소 수 (같은 상품을 여러 명이 걸어도 한 번만 확인)
const MAX_HTML_PER_RUN = 8;      // 그중 상품 페이지(HTML)를 통째로 읽는 수 (CPU 시간 때문에 따로 제한)
const SUBREQUEST_BUDGET = 44;    // 확인 + 알림 발송 + DB 호출 합계 상한
const CONCURRENCY = 6;           // 동시 연결 상한 (Workers 제한 6)
const FETCH_TIMEOUT = 10000;
const ERROR_ALERT_AFTER = 6 * 3600 * 1000;   // 이만큼 계속 확인 실패하면 한 번 알려줌
const SHOW_ERROR_AFTER = 30 * 60 * 1000;     // 일시적인 실패(요청 많음·응답 없음)는 이만큼 계속될 때만 목록에 오류로 표시
const TRANSIENT = new Set(['busy', 'timeout', 'network']);
const CHECKED_AT_EVERY = 10 * 60 * 1000;     // 변화 없을 때 "마지막 확인" 기록 주기 (DB 쓰기 줄이기)
const LINK_CODE_TTL = 15 * 60 * 1000;
const EMAIL_TOKEN_TTL = 24 * 3600 * 1000;
const EMAIL_RESEND_GAP = 60 * 1000;          // 인증 메일 다시 보내기 간격
const EMAIL_PER_DAY = 5;                     // 사용자당 하루 인증 메일 수
const REGISTER_PER_HOUR = 20;                // IP 당 시간당 가입 수
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

export default {
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      return json({ ok: false, error: 'server', detail: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, Date.now()));
  },
};

// ───────────────── 공통 ─────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
}
function page(title, body, status = 200) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;background:#faf8f5;color:#1d1a17;display:grid;place-items:center;min-height:100vh}
main{max-width:420px;padding:28px 24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#5c554e;margin:0}
@media(prefers-color-scheme:dark){body{background:#161412;color:#f2ede7}p{color:#a39a90}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const maxPerUser = env => Number(env.MAX_PER_USER) || 30;
const langOf = v => (v === 'en' ? 'en' : 'ko');

// ───────────────── 저장소 (D1) ─────────────────
// 테스트에서도 같은 SQL 을 그대로 씀 (node:sqlite)
export function makeStore(env) {
  const db = env.DB;
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const run = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const parse = r => ({ ...JSON.parse(r.data), id: r.id, userId: r.user_id, url: r.url });
  return {
    // 사용자
    createUser: (u) => run('INSERT INTO users (id, key_hash, lang, created_at) VALUES (?, ?, ?, ?)', u.id, u.keyHash, u.lang, u.createdAt),
    userByKeyHash: (h) => one('SELECT * FROM users WHERE key_hash = ?', h),
    userById: (id) => one('SELECT * FROM users WHERE id = ?', id),
    userByEmailToken: (t) => one('SELECT * FROM users WHERE email_token = ?', t),
    usersByIds: async (ids) => {
      if (!ids.length) return [];
      return all(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    },
    setTelegram: (id, chat, name) => run('UPDATE users SET tg_chat = ?, tg_name = ? WHERE id = ?', chat, name, id),
    unlinkTelegramChat: (chat) => run('UPDATE users SET tg_chat = NULL, tg_name = NULL WHERE tg_chat = ?', chat),
    setEmailPending: (id, email, token, exp, now, day, count) => run(
      'UPDATE users SET email_pending = ?, email_token = ?, email_token_exp = ?, email_sent_at = ?, email_sent_day = ?, email_sent_count = ? WHERE id = ?',
      email, token, exp, now, day, count, id),
    verifyEmail: (id, email) => run('UPDATE users SET email = ?, email_pending = NULL, email_token = NULL, email_token_exp = NULL WHERE id = ?', email, id),
    clearEmail: (id) => run('UPDATE users SET email = NULL, email_pending = NULL, email_token = NULL, email_token_exp = NULL WHERE id = ?', id),
    setLang: (id, lang) => run('UPDATE users SET lang = ? WHERE id = ?', lang, id),
    deleteUser: async (id) => {
      await db.batch([
        db.prepare('DELETE FROM alerts WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM link_codes WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(id),
      ]);
    },
    // 텔레그램 연결 코드
    addCode: (code, userId, exp) => run('INSERT INTO link_codes (code, user_id, exp) VALUES (?, ?, ?)', code, userId, exp),
    takeCode: async (code, now) => {
      const r = await one('SELECT * FROM link_codes WHERE code = ?', code);
      await run('DELETE FROM link_codes WHERE code = ? OR exp < ?', code, now);
      return r && r.exp >= now ? r : null;
    },
    // 알림
    alertsOf: async (userId) => (await all('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC', userId)).map(parse),
    allAlerts: async () => (await all('SELECT * FROM alerts ORDER BY created_at')).map(parse),
    countAlerts: async () => (await one('SELECT COUNT(*) AS n FROM alerts')).n,
    insertAlert: (a) => run('INSERT INTO alerts (id, user_id, url, data, created_at) VALUES (?, ?, ?, ?, ?)', a.id, a.userId, a.url, JSON.stringify(a), a.createdAt),
    removeAlert: async (id, userId) => {
      const r = await run('DELETE FROM alerts WHERE id = ? AND user_id = ?', id, userId);
      return (r.meta && r.meta.changes) || 0;
    },
    updateAlerts: async (list) => {
      if (!list.length) return;
      await db.batch(list.map(a => db.prepare('UPDATE alerts SET data = ? WHERE id = ?').bind(JSON.stringify(a), a.id)));
    },
    // 기타
    getMeta: async (k) => { const r = await one('SELECT v FROM meta WHERE k = ?', k); return r ? JSON.parse(r.v) : null; },
    setMeta: (k, v) => run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)),
  };
}

// ───────────────── HTTP ─────────────────
async function handle(req, env) {
  const url = new URL(req.url);
  const store = makeStore(env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, app: 'scentfinder-alerts' });

  // 텔레그램 → 서버 (사용자가 봇에서 "시작"을 누름)
  if (url.pathname === '/telegram/webhook' && req.method === 'POST') return telegramWebhook(req, env, store);
  // 메일 인증 링크 / 메일 수신 거부 링크
  if (url.pathname === '/verify' && req.method === 'GET') return verifyEmailPage(url, store);
  if (url.pathname === '/unsubscribe' && req.method === 'GET') return unsubscribePage(url, env, store);

  if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'notFound' }, 404);
  const path = url.pathname.slice(4);
  await rememberOrigin(store, url.origin);

  // 가입 (기기별, 접속 키 없이)
  if (req.method === 'POST' && path === '/register') {
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    const hourKey = `reg:${ip}:${Math.floor(Date.now() / 3600e3)}`;
    const n = (await store.getMeta(hourKey)) || 0;
    if (n >= REGISTER_PER_HOUR) return json({ ok: false, error: 'rateLimit' }, 429);
    await store.setMeta(hourKey, n + 1);
    const body = await readBody(req);
    const key = randHex(24);
    const user = { id: crypto.randomUUID(), keyHash: await sha256(key), lang: langOf(body.lang), createdAt: Date.now() };
    await store.createUser(user);
    return json({ ok: true, userId: user.id, key });
  }

  // 여기부터는 접속 키 필요
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const user = key ? await store.userByKeyHash(await sha256(key)) : null;
  if (!user) return json({ ok: false, error: 'auth' }, 401);

  if (req.method === 'GET' && path === '/me') {
    const [alerts, lastRun] = await Promise.all([store.alertsOf(user.id), store.getMeta('last_run')]);
    return json({ ok: true, me: meView(user, env), alerts, lastRun, maxPerUser: maxPerUser(env) });
  }

  if (req.method === 'DELETE' && path === '/me') {
    await store.deleteUser(user.id);
    return json({ ok: true });
  }

  if (req.method === 'POST' && path === '/lang') {
    await store.setLang(user.id, langOf((await readBody(req)).lang));
    return json({ ok: true });
  }

  // 텔레그램 연결 시작 → 연결 링크(t.me/봇?start=코드)를 돌려줌
  if (req.method === 'POST' && path === '/telegram/start') {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegramOff' }, 503);
    const bot = await ensureTelegram(env, store, url.origin);
    if (!bot) return json({ ok: false, error: 'telegramSetup' }, 502);
    const code = randHex(12);
    await store.addCode(code, user.id, Date.now() + LINK_CODE_TTL);
    return json({ ok: true, url: `https://t.me/${bot}?start=${code}`, bot });
  }
  if (req.method === 'DELETE' && path === '/telegram') {
    await store.setTelegram(user.id, null, null);
    return json({ ok: true });
  }

  // 이메일 등록 → 인증 메일
  if (req.method === 'POST' && path === '/email') {
    if (!env.RESEND_API_KEY) return json({ ok: false, error: 'emailOff' }, 503);
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ ok: false, error: 'badEmail' }, 400);
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const count = user.email_sent_day === day ? (user.email_sent_count || 0) : 0;
    if (user.email_sent_at && now - user.email_sent_at < EMAIL_RESEND_GAP) return json({ ok: false, error: 'tooSoon' }, 429);
    if (count >= EMAIL_PER_DAY) return json({ ok: false, error: 'tooMany' }, 429);
    const token = randHex(20);
    const lang = langOf(body.lang || user.lang);
    const t = L(lang);
    const link = `${url.origin}/verify?t=${token}`;
    const sent = await sendEmail(env, email, t.verifySubject, verifyHtml(t, link), `${t.verifyBody}\n\n${link}`);
    if (sent !== 'ok') return json({ ok: false, error: sent === 'http403' || sent === 'http422' ? 'emailDomain' : 'emailSend', detail: sent }, 502);
    await store.setEmailPending(user.id, email, token, now + EMAIL_TOKEN_TTL, now, day, count + 1);
    return json({ ok: true, pending: email });
  }
  if (req.method === 'DELETE' && path === '/email') {
    await store.clearEmail(user.id);
    return json({ ok: true });
  }

  if (req.method === 'POST' && path === '/test') {
    const lang = langOf((await readBody(req)).lang || user.lang);
    const t = L(lang);
    if (!user.tg_chat && !user.email) return json({ ok: false, error: 'noChannel' }, 400);
    const sent = await notifyUser(env, url.origin, user, { text: t.test, subject: t.testSubject, html: null }, null, store);
    return json({ ok: true, sent });
  }

  if (req.method === 'GET' && path === '/alerts') {
    return json({ ok: true, alerts: await store.alertsOf(user.id) });
  }

  if (req.method === 'POST' && path === '/alerts') {
    if (!user.tg_chat && !user.email) return json({ ok: false, error: 'noChannel' }, 400);
    const body = await readBody(req);
    const a = sanitizeAlert(body, user);
    if (!a) return json({ ok: false, error: 'badRequest' }, 400);
    const mine = await store.alertsOf(user.id);
    const dup = mine.find(x => x.url === a.url);
    if (dup) return json({ ok: true, alert: dup, duplicate: true });
    if (mine.length >= maxPerUser(env)) return json({ ok: false, error: 'limit', max: maxPerUser(env) }, 429);

    // 등록 전에 서버에서 실제로 확인되는지 봄 (봇 차단 사이트는 여기서 걸러짐)
    const res = await checkItem(a, new Budget(5));
    if (res.error) return json({ ok: false, error: res.error }, 422);
    if (res.available) return json({ ok: false, error: 'inStock', price: res.price }, 409);
    a.kind = res.kind;
    if (res.price) a.lastPrice = res.price;
    if (res.loose) a.loose = true;
    a.checkedAt = Date.now();
    await store.insertAlert(a);
    const msg = messageFor(a, 'watch');
    const sent = await notifyUser(env, url.origin, user, msg, null, store);
    return json({ ok: true, alert: a, sent });
  }

  const del = path.match(/^\/alerts\/([\w-]+)$/);
  if (req.method === 'DELETE' && del) {
    return json({ ok: true, removed: await store.removeAlert(del[1], user.id) });
  }

  return json({ ok: false, error: 'notFound' }, 404);
}

function meView(u, env) {
  return {
    id: u.id,
    telegram: u.tg_chat ? { name: u.tg_name || '' } : null,
    email: u.email || '',
    emailPending: u.email_pending || '',
    lang: u.lang,
    telegramAvailable: !!env.TELEGRAM_BOT_TOKEN,
    emailAvailable: !!env.RESEND_API_KEY,
    // 도메인 인증 전(EMAIL_FROM 없음)에는 Resend 가입 메일로만 보낼 수 있음
    emailLimited: !env.EMAIL_FROM,
  };
}

async function rememberOrigin(store, origin) {
  // 1분마다 실행되는 확인 작업이 메일의 수신 거부 링크를 만들 때 씀
  if (rememberOrigin.last === origin) return;
  rememberOrigin.last = origin;
  if ((await store.getMeta('origin')) !== origin) await store.setMeta('origin', origin);
}

const str = (v, n = 300) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
function sanitizeAlert(b, user) {
  let u;
  try { u = new URL(String(b.url || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  u.hash = '';
  const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    id: crypto.randomUUID(),
    userId: user.id,
    url: u.toString(),
    storeId: str(b.storeId, 60), storeName: str(b.storeName, 80),
    title: str(b.title, 200), variant: str(b.variant, 120), vendor: str(b.vendor, 80),
    size: num(b.size), category: str(b.category, 20),
    price: num(b.price), currency: str(b.currency, 3).toUpperCase() || 'USD',
    rate: num(b.rate),                       // 등록 때 환율: 상품 통화 1 = 표시 통화 몇 (환산 표시용)
    dispCur: /^[A-Z]{3}$/.test(str(b.dispCur, 3)) ? str(b.dispCur, 3) : 'KRW',   // 사용자가 보는 통화
    wooId: num(b.wooId), sku: str(b.sku, 60),
    lang: langOf(b.lang || user.lang),
    createdAt: Date.now(),
    inStock: false,
  };
}

// ───────────────── 텔레그램 연결 ─────────────────
// 봇 정보와 웹훅을 처음 한 번 자동 설정 (운영자가 따로 할 일 없음)
const webhookSecret = env => sha256('scentfinder:' + env.TELEGRAM_BOT_TOKEN).then(h => h.slice(0, 32));
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}
async function ensureTelegram(env, store, origin) {
  const tokenTag = (await sha256(env.TELEGRAM_BOT_TOKEN)).slice(0, 12);
  const want = `${origin}/telegram/webhook`;
  const saved = await store.getMeta('tg_bot');
  if (saved && saved.tag === tokenTag && saved.webhook === want) return saved.username;
  try {
    const me = await tg(env, 'getMe');
    if (!me.data || !me.data.ok) return null;
    const hook = await tg(env, 'setWebhook', { url: want, secret_token: await webhookSecret(env), allowed_updates: ['message'] });
    if (!hook.data || !hook.data.ok) return null;
    await store.setMeta('tg_bot', { tag: tokenTag, webhook: want, username: me.data.result.username });
    return me.data.result.username;
  } catch { return null; }
}

async function telegramWebhook(req, env, store) {
  if (!env.TELEGRAM_BOT_TOKEN || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) {
    return new Response('forbidden', { status: 403 });
  }
  const upd = await readBody(req);
  const m = upd.message;
  if (!m || !m.chat || m.chat.type !== 'private' || typeof m.text !== 'string') return new Response('ok');
  const chat = String(m.chat.id);
  const name = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '';
  const t = L(m.from && /^ko/i.test(m.from.language_code || 'ko') ? 'ko' : 'en');
  const [cmd, arg] = m.text.trim().split(/\s+/, 2);
  if (cmd === '/start' && arg) {
    const code = await store.takeCode(arg.slice(0, 64), Date.now());
    if (!code) { await sendTelegram(env, chat, t.tgCodeExpired); return new Response('ok'); }
    await store.setTelegram(code.user_id, chat, name);
    const user = await store.userById(code.user_id);
    await sendTelegram(env, chat, L(user ? user.lang : 'ko').linked);
  } else if (cmd === '/stop') {
    await store.unlinkTelegramChat(chat);
    await sendTelegram(env, chat, t.tgStopped);
  } else {
    await sendTelegram(env, chat, t.tgHelp);
  }
  return new Response('ok');
}

// ───────────────── 메일 인증·수신 거부 ─────────────────
async function verifyEmailPage(url, store) {
  const token = String(url.searchParams.get('t') || '').slice(0, 64);
  const user = token ? await store.userByEmailToken(token) : null;
  if (!user || !user.email_pending || user.email_token_exp < Date.now()) {
    const t = L(user ? user.lang : 'ko');
    return page(t.verifyFailTitle, t.verifyFailBody, 400);
  }
  await store.verifyEmail(user.id, user.email_pending);
  const t = L(user.lang);
  return page(t.verifyOkTitle, t.verifyOkBody.replace('{email}', user.email_pending));
}

const unsubSig = (env, userId) => hmac(env.RESEND_API_KEY || 'x', 'unsub:' + userId);
async function unsubscribeLink(env, origin, userId) {
  if (!origin) return '';
  return `${origin}/unsubscribe?u=${encodeURIComponent(userId)}&s=${await unsubSig(env, userId)}`;
}
async function unsubscribePage(url, env, store) {
  const id = String(url.searchParams.get('u') || '');
  const user = id ? await store.userById(id) : null;
  if (!user || url.searchParams.get('s') !== await unsubSig(env, id)) return page('—', 'Invalid link', 400);
  await store.clearEmail(id);
  const t = L(user.lang);
  return page(t.unsubTitle, t.unsubBody);
}

// ───────────────── 재고 확인 ─────────────────
export class Budget {
  constructor(max) { this.max = max; this.used = 0; }
  take(n = 1) { if (this.used + n > this.max) return false; this.used += n; return true; }
  get left() { return this.max - this.used; }
}

async function get(url, budget, accept) {
  if (!budget.take()) return { skipped: true };
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    return { r };
  } catch (e) {
    return { error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

const CHALLENGE = /just a moment|attention required|access denied|verify you are human|are you a robot|pardon our interruption|request unsuccessful/i;
// 차단 응답의 정보 (원인 파악용으로 알림 기록에 남김)
const blockInfo = (r, text) => ({ status: r.status, detail: String(((String(text).match(/<title[^>]*>([^<]*)/i) || [])[1]) || String(text).slice(0, 80)).trim().slice(0, 80) });
// 429(요청이 너무 많음)·503(잠시 이용 불가)은 차단이 아니라 일시적인 응답 → busy
const isBusy = status => status === 429 || status === 503;
const isBlocked = (status, text) => status === 403 ||
  CHALLENGE.test((String(text).match(/<title[^>]*>([^<]*)/i) || [])[1] || '');

export async function checkItem(w, budget) {
  const u = new URL(w.url);
  const handle = (u.pathname.match(/\/products\/([^/?#]+)/) || [])[1];
  if ((!w.kind || w.kind === 'shopify') && handle) {
    const r = await checkShopify(w, u, handle, budget);
    if (w.kind === 'shopify' || !r.notShopify) return r;
  }
  if ((!w.kind || w.kind === 'woo') && w.wooId) {
    const r = await checkWoo(w, u, budget);
    if (w.kind === 'woo' || !r.notWoo) return r;
  }
  return checkHtml(w, budget);
}

async function checkShopify(w, u, handle, budget) {
  const { r, error, skipped } = await get(`${u.origin}/products/${handle}.js`, budget, 'application/json');
  if (skipped) return { skipped: true };
  if (error) return { error };
  const text = await r.text();
  if (r.status === 404) return w.kind ? { error: 'notFound' } : { notShopify: true };
  if (isBusy(r.status)) return { error: 'busy', ...blockInfo(r, text) };
  if (isBlocked(r.status, text)) return w.kind ? { error: 'blocked', ...blockInfo(r, text) } : { notShopify: true, blocked: true };
  let d;
  try { d = JSON.parse(text); } catch { return w.kind ? { error: 'blocked', ...blockInfo(r, text) } : { notShopify: true }; }
  if (!d || !Array.isArray(d.variants)) return w.kind ? { error: 'unsupported' } : { notShopify: true };
  const vid = u.searchParams.get('variant');
  let v = null;
  if (vid) {
    v = d.variants.find(x => String(x.id) === vid);
    if (!v) return { error: 'variantGone' };
  }
  const available = v ? !!v.available : d.variants.some(x => x.available);
  const pick = v || d.variants.find(x => x.available) || d.variants[0];
  return { kind: 'shopify', available, price: pick ? pick.price / 100 : null };
}

async function checkWoo(w, u, budget) {
  const { r, error, skipped } = await get(`${u.origin}/wp-json/wc/store/v1/products/${w.wooId}`, budget, 'application/json');
  if (skipped) return { skipped: true };
  if (error) return { error };
  const text = await r.text();
  if (isBusy(r.status)) return { error: 'busy', ...blockInfo(r, text) };
  if (isBlocked(r.status, text)) return w.kind ? { error: 'blocked' } : { notWoo: true };
  let p;
  try { p = JSON.parse(text); } catch { return w.kind ? { error: 'unsupported' } : { notWoo: true }; }
  if (!p || p.is_in_stock == null) return w.kind ? { error: 'unsupported' } : { notWoo: true };
  const minor = Number(p.prices?.currency_minor_unit ?? 2);
  return { kind: 'woo', available: !!p.is_in_stock, price: Number(p.prices?.price) / Math.pow(10, minor) || null };
}

// 상품 페이지의 구조화 데이터(JSON-LD)에서 재고 확인
async function checkHtml(w, budget) {
  const { r, error, skipped } = await get(w.url, budget, 'text/html,application/xhtml+xml');
  if (skipped) return { skipped: true };
  if (error) return { error };
  const text = await r.text();
  if (isBusy(r.status)) return { error: 'busy', ...blockInfo(r, text) };
  if (isBlocked(r.status, text)) return { error: 'blocked', ...blockInfo(r, text) };
  if (r.status === 404 || r.status === 410) return { error: 'notFound' };
  const offers = extractOffers(text);
  if (!offers.length) return { error: 'unsupported' };
  const { offer, loose } = pickOffer(offers, w);
  if (!offer || offer.available == null) return { error: 'unsupported' };
  return { kind: 'html', available: offer.available, price: offer.price, loose };
}

export function extractOffers(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (n, f) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return; }
    f(n);
    ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant'].forEach(k => n[k] && walk(n[k], f));
  };
  const isProduct = n => { const t = n['@type']; return Array.isArray(t) ? t.includes('Product') : t === 'Product'; };
  while ((m = re.exec(html))) {
    let j;
    try { j = JSON.parse(m[1].trim()); } catch { continue; }
    walk(j, n => {
      if (!isProduct(n) || !n.offers) return;
      const offers = [].concat(n.offers).flatMap(o => (o && Array.isArray(o.offers)) ? o.offers : [o]);
      for (const o of offers) {
        if (!o) continue;
        const av = o.availability == null ? null : /InStock|LimitedAvailability|OnlineOnly|PreOrder/i.test(String(o.availability));
        const price = Number(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
        out.push({ name: [n.name, o.name].filter(Boolean).join(' '), sku: String(o.sku || n.sku || ''), url: o.url || '', price: Number.isFinite(price) ? price : null, available: av });
      }
    });
  }
  return out;
}

const sizeOf = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*ml\b/i); return m ? Math.round(parseFloat(m[1])) : null; };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function pickOffer(offers, w) {
  if (offers.length === 1) return { offer: offers[0] };
  const clean = u => String(u || '').split('#')[0];
  let o = offers.find(x => x.url && clean(x.url) === clean(w.url));
  if (!o && w.sku) o = offers.find(x => x.sku && x.sku === w.sku);
  if (!o && w.variant) o = offers.find(x => norm(x.name).includes(norm(w.variant)) && norm(w.variant));
  if (!o && w.size) o = offers.find(x => sizeOf(x.name) === w.size);
  if (o) return { offer: o };
  // 옵션을 특정하지 못하면 "어떤 옵션이든 재고가 있으면" 기준 (알림에 옵션 확인 필요 표시)
  const known = offers.filter(x => x.available != null);
  if (!known.length) return { offer: null };
  const inStock = known.find(x => x.available);
  return { offer: inStock || known[0], loose: true };
}

// ───────────────── 1분마다 실행 ─────────────────
const rotate = (arr, cap, minute) => {
  if (arr.length <= cap) return arr;
  const start = (minute * cap) % arr.length;
  return [...arr.slice(start), ...arr.slice(0, start)].slice(0, cap);
};

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

export async function runChecks(env, now) {
  const store = makeStore(env);
  const budget = new Budget(SUBREQUEST_BUDGET);
  budget.take(4);   // DB 읽기·쓰기·기록
  const [alerts, origin] = await Promise.all([store.allAlerts(), store.getMeta('origin')]);
  const minute = Math.floor(now / 60000);

  // 같은 상품을 여러 명이 걸어도 쇼핑몰에는 한 번만 확인
  const byUrl = new Map();
  for (const a of alerts) {
    if (!byUrl.has(a.url)) byUrl.set(a.url, []);
    byUrl.get(a.url).push(a);
  }
  const groups = [...byUrl.values()];
  const html = groups.filter(g => g[0].kind === 'html');
  const fast = groups.filter(g => g[0].kind !== 'html');
  const htmlPick = rotate(html, MAX_HTML_PER_RUN, minute);
  const pick = [...rotate(fast, MAX_CHECKS_PER_RUN - htmlPick.length, minute), ...htmlPick];

  const results = new Map();
  await pool(pick, CONCURRENCY, async g => { results.set(g[0].url, await checkItem(g[0], budget)); });

  const userIds = [...new Set(pick.flat().map(a => a.userId))];
  const users = new Map((await store.usersByIds(userIds)).map(u => [u.id, u]));

  const changed = [];
  const summary = { checked: 0, restocked: 0, errors: 0, deferred: 0 };
  for (const g of pick) {
    const res = results.get(g[0].url);
    if (!res || res.skipped) { summary.deferred += g.length; continue; }
    summary.checked++;
    if (res.error) summary.errors++;
    for (const a of g) {
      const user = users.get(a.userId);
      let dirty = false;
      if (res.error) {
        if (!a.errorSince) { a.errorSince = now; dirty = true; }
        // 일시적인 실패는 30분 넘게 이어질 때만 오류로 표시 (그 전엔 조용히 다음 분에 다시 확인)
        const show = !TRANSIENT.has(res.error) || now - a.errorSince >= SHOW_ERROR_AFTER;
        if (show && a.lastError !== res.error) { a.lastError = res.error; dirty = true; }
        if (res.status && a.lastStatus !== `${res.status} ${res.detail || ''}`) { a.lastStatus = `${res.status} ${res.detail || ''}`; dirty = true; }
        if (user && !a.errorNotified && now - a.errorSince >= ERROR_ALERT_AFTER && budget.left >= 2) {
          await notifyUser(env, origin, user, messageFor(a, 'error'), budget, store);
          a.errorNotified = true; dirty = true;
        }
      } else {
        if (a.errorSince || a.lastError || a.lastStatus) { delete a.errorSince; delete a.errorNotified; delete a.lastError; delete a.lastStatus; dirty = true; }
        if (res.price && res.price !== a.lastPrice) { a.lastPrice = res.price; dirty = true; }
        if (res.available && !a.inStock) {
          // 알림을 보낼 여유가 없으면 다음 실행에서 다시 (재고 상태를 바꾸지 않음)
          if (!user || budget.left < 2) { summary.deferred++; if (dirty) changed.push(a); continue; }
          const sent = await notifyUser(env, origin, user, messageFor(a, 'restock'), budget, store);
          if (sent.telegram === 'ok' || sent.email === 'ok') {
            a.inStock = true; a.restockedAt = now; a.restockCount = (a.restockCount || 0) + 1;
            summary.restocked++; dirty = true;
          }
        } else if (!res.available && a.inStock) {
          // 다시 품절 → 다음 재입고 때 또 알림
          a.inStock = false; dirty = true;
        }
      }
      if (dirty || !a.checkedAt || now - a.checkedAt >= CHECKED_AT_EVERY) { a.checkedAt = now; changed.push(a); }
    }
  }
  await store.updateAlerts(changed);
  await store.setMeta('last_run', { at: now, ...summary, total: alerts.length, urls: groups.length });
  return summary;
}

// ───────────────── 알림 발송 ─────────────────
async function notifyUser(env, origin, user, msg, budget, store) {
  const sent = { telegram: 'off', email: 'off' };
  if (user.tg_chat && env.TELEGRAM_BOT_TOKEN && (!budget || budget.take())) {
    sent.telegram = await sendTelegram(env, user.tg_chat, msg.text);
    // 사용자가 봇을 차단했으면 연결 해제
    if (sent.telegram === 'http403' && store) await store.setTelegram(user.id, null, null);
  }
  if (user.email && env.RESEND_API_KEY && (!budget || budget.take())) {
    const t = L(user.lang);
    const unsub = await unsubscribeLink(env, origin, user.id);
    const footHtml = unsub ? `<p style="margin-top:24px;font-size:12px;color:#8a837b">${esc(t.emailFoot)} <a href="${esc(unsub)}" style="color:#8a837b">${esc(t.unsubLink)}</a></p>` : '';
    const footText = unsub ? `\n\n${t.emailFoot} ${t.unsubLink}: ${unsub}` : '';
    sent.email = await sendEmail(env, user.email, msg.subject || textSubject(msg.text),
      (msg.html || textHtml(msg.text)) + footHtml, stripTags(msg.text) + footText,
      unsub ? { 'List-Unsubscribe': `<${unsub}>` } : null);
  }
  return sent;
}

async function sendTelegram(env, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    return r.ok ? 'ok' : `http${r.status}`;
  } catch { return 'network'; }
}

async function sendEmail(env, to, subject, html, text, headers) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Scent Price Finder <onboarding@resend.dev>',
        to: [to], subject, html, text, ...(headers ? { headers } : {}),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    return r.ok ? 'ok' : `http${r.status}`;
  } catch { return 'network'; }
}

const verifyHtml = (t, link) => `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;color:#1d1a17">
<p>${esc(t.verifyBody)}</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#8a5a2b;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">${esc(t.verifyButton)}</a></p>
<p style="font-size:12px;color:#8a837b">${esc(t.verifyIgnore)}</p></div>`;

// ───────────────── 메시지 문구 ─────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => String(s).replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 $1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const textSubject = text => stripTags(text).split('\n')[0].slice(0, 120);
const textHtml = text => `<div style="font:15px/1.6 -apple-system,sans-serif;white-space:pre-wrap">${text.replace(/\n/g, '<br>')}</div>`;

const SYM = { USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$', KRW: '₩' };
const money = (p, c) => (p == null ? '' : `${SYM[c] || c + ' '}${Number(p).toFixed(c === 'KRW' ? 0 : 2)}`);
// 사용자 통화로 환산 (등록 때 환율 기준). 상품 통화와 같으면 표시 안 함
const approx = (p, w) => {
  const c = w.dispCur || 'KRW';
  if (!p || !w.rate || c === w.currency) return '';
  const v = p * w.rate;
  return c === 'KRW' ? `₩${Math.round(v).toLocaleString('ko-KR')}` : money(v, c);
};

const TEXT = {
  ko: {
    cat: { boxed: '정품', tester: '테스터', unboxed: '언박스', sample: '미니/샘플', set: '세트' },
    linked: '🔗 <b>향수 최저가</b> 알림이 이 텔레그램에 연결됐어요.\n품절 상품에 🔔 재입고 알림을 걸면 여기로 바로 알려드릴게요.\n\n연결을 끊으려면 /stop',
    testSubject: '[향수 최저가] 테스트 알림',
    tgCodeExpired: '연결 링크가 만료됐어요. 확장 프로그램의 "재입고 알림"에서 "텔레그램 연결"을 다시 눌러 주세요.',
    tgStopped: '연결을 끊었어요. 이제 이 텔레그램으로는 알림이 오지 않아요.',
    tgHelp: '향수 최저가 재입고 알림 봇이에요. 연결하려면 Safari 확장 프로그램의 "재입고 알림"에서 "텔레그램 연결"을 눌러 주세요. 연결을 끊으려면 /stop',
    verifySubject: '[향수 최저가] 메일 주소를 인증해 주세요',
    verifyBody: '재입고 알림을 이 메일로 받으려면 아래 버튼을 눌러 주세요. 링크는 24시간 동안 유효해요.',
    verifyButton: '메일 주소 인증하기',
    verifyIgnore: '직접 신청하지 않았다면 이 메일을 무시하세요. 아무 알림도 가지 않아요.',
    verifyOkTitle: '인증 완료',
    verifyOkBody: '{email} 로 재입고 알림을 보내드릴게요. 이 창은 닫아도 돼요.',
    verifyFailTitle: '인증 링크가 맞지 않아요',
    verifyFailBody: '링크가 만료됐거나 이미 사용됐어요. 확장 프로그램에서 인증 메일을 다시 보내 주세요.',
    unsubTitle: '메일 알림을 껐어요',
    unsubBody: '이 메일 주소로는 더 이상 알림이 가지 않아요. 확장 프로그램에서 다시 등록할 수 있어요.',
    emailFoot: '향수 최저가 재입고 알림 메일이에요.',
    unsubLink: '메일 알림 끄기',
    test: '🧪 <b>향수 최저가</b> 테스트 알림이에요.\n이 메시지가 보이면 알림이 잘 설정된 거예요.',
    watchHead: '🔔 재입고 알림 설정 완료', restockHead: '✅ 재입고!', errorHead: '⚠️ 재고 확인이 계속 실패하고 있어요',
    site: '사이트', name: '향수', option: '옵션', last: '마지막 가격', now: '현재 가격', approx: '약',
    watchFoot: '재고가 들어오면 바로 알려드릴게요. (1분마다 확인)',
    restockFoot: '수량이 적을 수 있으니 빨리 확인해 보세요.',
    looseNote: '이 사이트는 옵션별 재고를 구분하지 못해서, 다른 용량만 입고돼도 알림이 갈 수 있어요.',
    errorFoot: '6시간째 확인이 안 돼요. 사이트가 접속을 막았거나 상품 페이지가 바뀌었을 수 있어요. 확장의 재입고 알림 목록에서 확인해 주세요.',
    buy: '바로 구매하기', open: '상품 페이지 열기',
  },
  en: {
    cat: { boxed: 'Boxed', tester: 'Tester', unboxed: 'Unboxed', sample: 'Mini/sample', set: 'Set' },
    linked: '🔗 <b>Scent Price Finder</b> alerts are now linked to this Telegram chat.\nTap 🔔 on a sold-out item and you will be notified here.\n\nTo unlink, send /stop',
    testSubject: '[Scent Price Finder] Test alert',
    tgCodeExpired: 'This link has expired. Tap "Link Telegram" again in the extension\'s Restock alerts.',
    tgStopped: 'Unlinked. You will no longer get alerts in this chat.',
    tgHelp: 'This is the Scent Price Finder restock alert bot. To link it, tap "Link Telegram" in the Safari extension\'s Restock alerts. To unlink, send /stop',
    verifySubject: '[Scent Price Finder] Confirm your email address',
    verifyBody: 'Tap the button below to get restock alerts at this address. The link is valid for 24 hours.',
    verifyButton: 'Confirm email address',
    verifyIgnore: 'If you did not request this, ignore this email. Nothing will be sent.',
    verifyOkTitle: 'Email confirmed',
    verifyOkBody: 'Restock alerts will be sent to {email}. You can close this page.',
    verifyFailTitle: 'This link is not valid',
    verifyFailBody: 'It has expired or was already used. Send a new confirmation email from the extension.',
    unsubTitle: 'Email alerts turned off',
    unsubBody: 'No more alerts will be sent to this address. You can register again in the extension.',
    emailFoot: 'You get this because you set a restock alert in Scent Price Finder.',
    unsubLink: 'Turn off email alerts',
    test: '🧪 <b>Scent Price Finder</b> test alert. If you see this, alerts are set up correctly.',
    watchHead: '🔔 Restock alert is set', restockHead: '✅ Back in stock!', errorHead: '⚠️ Stock checks keep failing',
    site: 'Store', name: 'Fragrance', option: 'Option', last: 'Last price', now: 'Price now', approx: 'about',
    watchFoot: 'You will be notified as soon as it is back. (checked every minute)',
    restockFoot: 'Stock may be limited — check it soon.',
    looseNote: 'This store does not show stock per option, so an alert may fire when a different size comes back.',
    errorFoot: 'Checks have failed for 6 hours. The store may be blocking access or the page changed.',
    buy: 'Buy now', open: 'Open product page',
  },
};
const L = lang => TEXT[lang] || TEXT.ko;

export function messageFor(w, kind) {
  const t = L(w.lang);
  const head = kind === 'watch' ? t.watchHead : kind === 'restock' ? t.restockHead : t.errorHead;
  const opt = [w.variant, w.size && !String(w.variant).includes(String(w.size)) ? `${w.size}ml` : '', t.cat[w.category] || '']
    .filter(Boolean).join(' · ');
  const price = kind === 'restock' ? (w.lastPrice ?? w.price) : (w.price ?? w.lastPrice);
  const priceLine = price != null ? `${money(price, w.currency)}${approx(price, w) ? ` (${t.approx} ${approx(price, w)})` : ''}` : '';
  const name = [w.vendor && !w.title.toLowerCase().includes(w.vendor.toLowerCase()) ? w.vendor : '', w.title].filter(Boolean).join(' ');
  const foot = kind === 'watch' ? t.watchFoot : kind === 'restock' ? t.restockFoot : t.errorFoot;
  const lines = [
    `<b>${esc(head)}</b>`, '',
    `${t.site}: <b>${esc(w.storeName)}</b>`,
    `${t.name}: ${esc(name)}`,
    opt ? `${t.option}: ${esc(opt)}` : '',
    priceLine ? `${kind === 'restock' ? t.now : t.last}: ${esc(priceLine)}` : '',
    '', esc(foot),
    w.loose ? esc(t.looseNote) : '',
    '', `<a href="${esc(w.url)}">${esc(kind === 'restock' ? t.buy : t.open)}</a>`,
  ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const subject = `[${w.lang === 'en' ? 'Scent Price Finder' : '향수 최저가'}] ${head.replace(/^\S+\s/, '')} — ${w.storeName} · ${name}`.slice(0, 150);
  const html = `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;color:#1d1a17">${
    lines.map(l => (l ? l : '&nbsp;')).join('<br>')
      .replace(/<a href="([^"]+)">([^<]*)<\/a>/, '<a href="$1" style="display:inline-block;margin-top:6px;padding:10px 16px;background:#8a5a2b;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">$2</a>')
  }</div>`;
  return { text, subject, html };
}
