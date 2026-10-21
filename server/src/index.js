// 향수 최저가 — 재입고 알림 서버 (Cloudflare Workers + D1)
//
// - 확장 프로그램이 품절 상품을 등록하면 1분마다 재고를 확인
// - 재고가 들어오면 텔레그램 + 이메일(Resend)로 바로 알림
// - 등록하자마자 "알림 설정 완료" 메시지를 같은 경로로 보냄
//
// 비밀값 (wrangler secret put …):
//   API_TOKEN          확장 프로그램과 서버가 공유하는 접속 키
//   TELEGRAM_BOT_TOKEN @BotFather 에서 받은 봇 토큰
//   RESEND_API_KEY     Resend API 키
//   EMAIL_TO           알림 받을 메일 주소 (Resend 가입 메일. 도메인 인증 전에는 이 주소로만 보낼 수 있음)

// ── 무료 요금제 한도 안에서 돌도록 맞춘 값 ──
// Workers Free: 실행 한 번에 외부 요청 50개, CPU 10ms, 크론 최소 1분
const MAX_CHECKS_PER_RUN = 25;   // 1분에 확인하는 상품 수 (넘으면 돌아가며 확인)
const MAX_HTML_PER_RUN = 8;      // 그중 상품 페이지(HTML)를 통째로 읽는 상품 수 (CPU 시간 때문에 따로 제한)
const SUBREQUEST_BUDGET = 44;    // 확인 + 알림 발송 + DB 호출 합계 상한
const CONCURRENCY = 6;           // 동시 연결 상한 (Workers 제한 6)
const FETCH_TIMEOUT = 10000;
const ERROR_ALERT_AFTER = 6 * 3600 * 1000;   // 이만큼 계속 확인 실패하면 한 번 알려줌
const CHECKED_AT_EVERY = 10 * 60 * 1000;     // 변화 없을 때 "마지막 확인" 기록 주기 (DB 쓰기 줄이기)
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

// ───────────────── 저장소 (D1) ─────────────────
// 테스트에서는 env.__store 로 바꿔 끼움
export function makeStore(env) {
  if (env.__store) return env.__store;
  const db = env.DB;
  return {
    async list() {
      const { results } = await db.prepare('SELECT data FROM watches ORDER BY created_at DESC').all();
      return results.map(r => JSON.parse(r.data));
    },
    async insert(w) {
      await db.prepare('INSERT INTO watches (id, url, data, created_at) VALUES (?, ?, ?, ?)').bind(w.id, w.url, JSON.stringify(w), w.createdAt).run();
    },
    async remove(id) {
      const r = await db.prepare('DELETE FROM watches WHERE id = ?').bind(id).run();
      return (r.meta && r.meta.changes) || 0;
    },
    async updateMany(ws) {
      if (!ws.length) return;
      await db.batch(ws.map(w => db.prepare('UPDATE watches SET data = ? WHERE id = ?').bind(JSON.stringify(w), w.id)));
    },
    async getMeta(k) {
      const r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
      return r ? JSON.parse(r.v) : null;
    },
    async setMeta(k, v) {
      await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();
    },
  };
}

// ───────────────── HTTP API ─────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
}

async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, app: 'scentfinder-alerts' });
  if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'notFound' }, 404);

  // 접속 키 확인
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.API_TOKEN || auth !== env.API_TOKEN) return json({ ok: false, error: 'auth' }, 401);

  const store = makeStore(env);
  const path = url.pathname.slice(4);   // /api 뒤

  if (req.method === 'GET' && path === '/status') {
    const [watches, chat, lastRun] = await Promise.all([store.list(), store.getMeta('tg_chat'), store.getMeta('last_run')]);
    return json({
      ok: true,
      telegram: !!(chat && env.TELEGRAM_BOT_TOKEN), telegramName: chat ? chat.name : '',
      telegramToken: !!env.TELEGRAM_BOT_TOKEN,
      email: !!(env.RESEND_API_KEY && env.EMAIL_TO), emailTo: env.EMAIL_TO ? maskEmail(env.EMAIL_TO) : '',
      watches: watches.length, lastRun,
    });
  }

  if (req.method === 'POST' && path === '/telegram/link') {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'noTelegramToken' }, 400);
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const data = await r.json().catch(() => null);
    if (!data || !data.ok) return json({ ok: false, error: 'telegramToken' }, 400);
    const msgs = (data.result || []).map(u => u.message || u.edited_message).filter(m => m && m.chat && m.chat.type === 'private');
    const last = msgs[msgs.length - 1];
    if (!last) return json({ ok: false, error: 'noMessage' }, 404);
    const chat = { id: last.chat.id, name: [last.chat.first_name, last.chat.last_name].filter(Boolean).join(' ') || last.chat.username || '' };
    await store.setMeta('tg_chat', chat);
    const lang = (await readBody(req)).lang === 'en' ? 'en' : 'ko';
    const sent = await sendTelegram(env, chat.id, L(lang).linked);
    return json({ ok: true, name: chat.name, sent });
  }

  if (req.method === 'POST' && path === '/test') {
    const lang = (await readBody(req)).lang === 'en' ? 'en' : 'ko';
    const sent = await notify(env, store, null, L(lang).test, null);
    return json({ ok: true, sent });
  }

  if (req.method === 'GET' && path === '/watches') {
    return json({ ok: true, watches: await store.list() });
  }

  if (req.method === 'POST' && path === '/watches') {
    const body = await readBody(req);
    const w = sanitizeWatch(body);
    if (!w) return json({ ok: false, error: 'badRequest' }, 400);
    const all = await store.list();
    const dup = all.find(x => x.url === w.url);
    if (dup) return json({ ok: true, watch: dup, duplicate: true });

    // 등록 전에 서버에서 실제로 확인되는지 봄 (봇 차단 사이트는 여기서 걸러짐)
    const res = await checkItem(w, new Budget(5));
    if (res.error) return json({ ok: false, error: res.error }, 422);
    if (res.available) return json({ ok: false, error: 'inStock', price: res.price }, 409);
    w.kind = res.kind;
    if (res.price) w.lastPrice = res.price;
    if (res.loose) w.loose = true;
    w.checkedAt = Date.now();
    await store.insert(w);
    const msg = messageFor(w, 'watch');
    const sent = await notify(env, store, null, msg.text, msg);
    return json({ ok: true, watch: w, sent });
  }

  const del = path.match(/^\/watches\/([\w-]+)$/);
  if (req.method === 'DELETE' && del) {
    const n = await store.remove(del[1]);
    return json({ ok: true, removed: n });
  }

  return json({ ok: false, error: 'notFound' }, 404);
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return '';
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

const str = (v, n = 300) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
function sanitizeWatch(b) {
  let u;
  try { u = new URL(String(b.url || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  u.hash = '';
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    id: crypto.randomUUID(),
    url: u.toString(),
    storeId: str(b.storeId, 60), storeName: str(b.storeName, 80),
    title: str(b.title, 200), variant: str(b.variant, 120), vendor: str(b.vendor, 80),
    size: num(b.size), category: str(b.category, 20),
    price: num(b.price), currency: str(b.currency, 3).toUpperCase() || 'USD',
    rate: num(b.rate),                       // 등록 때 환율 (원화 환산 표시용)
    wooId: num(b.wooId), sku: str(b.sku, 60),
    lang: b.lang === 'en' ? 'en' : 'ko',
    createdAt: Date.now(),
    inStock: false,
  };
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
const isBlocked = (status, text) => status === 403 || status === 429 || status === 503 ||
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
  if (isBlocked(r.status, text)) return w.kind ? { error: 'blocked' } : { notShopify: true, blocked: true };
  let d;
  try { d = JSON.parse(text); } catch { return w.kind ? { error: 'blocked' } : { notShopify: true }; }
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
  if (isBlocked(r.status, text)) return { error: 'blocked' };
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
  budget.take(3);   // DB 읽기·쓰기·기록
  const watches = await store.list();
  const minute = Math.floor(now / 60000);

  const html = watches.filter(w => w.kind === 'html');
  const fast = watches.filter(w => w.kind !== 'html');
  const htmlPick = rotate(html, MAX_HTML_PER_RUN, minute);
  const pick = [...rotate(fast, MAX_CHECKS_PER_RUN - htmlPick.length, minute), ...htmlPick];

  const results = new Map();
  await pool(pick, CONCURRENCY, async w => { results.set(w.id, await checkItem(w, budget)); });

  const changed = [];
  const summary = { checked: 0, restocked: 0, errors: 0, deferred: 0 };
  for (const w of pick) {
    const res = results.get(w.id);
    if (!res || res.skipped) { summary.deferred++; continue; }
    summary.checked++;
    let dirty = false;
    if (res.error) {
      summary.errors++;
      if (w.lastError !== res.error) { w.lastError = res.error; dirty = true; }
      if (!w.errorSince) { w.errorSince = now; dirty = true; }
      if (!w.errorNotified && now - w.errorSince >= ERROR_ALERT_AFTER && budget.left >= 2) {
        const msg = messageFor(w, 'error');
        await notify(env, store, budget, msg.text, msg);
        w.errorNotified = true; dirty = true;
      }
    } else {
      if (w.errorSince || w.lastError) { delete w.errorSince; delete w.errorNotified; delete w.lastError; dirty = true; }
      if (res.price && res.price !== w.lastPrice) { w.lastPrice = res.price; dirty = true; }
      if (res.available && !w.inStock) {
        // 알림을 보낼 여유가 없으면 다음 실행에서 다시 (재고 상태를 바꾸지 않음)
        if (budget.left < 2) { summary.deferred++; continue; }
        const msg = messageFor(w, 'restock');
        const sent = await notify(env, store, budget, msg.text, msg);
        if (sent.telegram === 'ok' || sent.email === 'ok') {
          w.inStock = true; w.restockedAt = now; w.restockCount = (w.restockCount || 0) + 1;
          summary.restocked++; dirty = true;
        }
      } else if (!res.available && w.inStock) {
        // 다시 품절 → 다음 재입고 때 또 알림
        w.inStock = false; dirty = true;
      }
    }
    if (dirty || !w.checkedAt || now - w.checkedAt >= CHECKED_AT_EVERY) { w.checkedAt = now; changed.push(w); }
  }
  await store.updateMany(changed);
  await store.setMeta('last_run', { at: now, ...summary, total: watches.length });
  return summary;
}

// ───────────────── 알림 발송 ─────────────────
async function notify(env, store, budget, text, msg) {
  const sent = { telegram: 'off', email: 'off' };
  const chat = env.TELEGRAM_BOT_TOKEN ? await store.getMeta('tg_chat') : null;
  if (chat && (!budget || budget.take())) sent.telegram = await sendTelegram(env, chat.id, text);
  else if (env.TELEGRAM_BOT_TOKEN && !chat) sent.telegram = 'notLinked';
  if (env.RESEND_API_KEY && env.EMAIL_TO && (!budget || budget.take())) {
    sent.email = await sendEmail(env, msg ? msg.subject : textSubject(text), msg ? msg.html : textHtml(text), text);
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

async function sendEmail(env, subject, html, text) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Scent Price Finder <onboarding@resend.dev>',
        to: [env.EMAIL_TO], subject, html, text: stripTags(text),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    return r.ok ? 'ok' : `http${r.status}`;
  } catch { return 'network'; }
}

// ───────────────── 메시지 문구 ─────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => String(s).replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 $1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const textSubject = text => stripTags(text).split('\n')[0].slice(0, 120);
const textHtml = text => `<div style="font:15px/1.6 -apple-system,sans-serif;white-space:pre-wrap">${text.replace(/\n/g, '<br>')}</div>`;

const SYM = { USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$', KRW: '₩' };
const money = (p, c) => (p == null ? '' : `${SYM[c] || c + ' '}${Number(p).toFixed(c === 'KRW' ? 0 : 2)}`);
const krw = (p, rate) => (p && rate ? `₩${Math.round(p * rate).toLocaleString('ko-KR')}` : '');

const TEXT = {
  ko: {
    cat: { boxed: '정품', tester: '테스터', unboxed: '언박스', sample: '미니/샘플', set: '세트' },
    linked: '🔗 <b>향수 최저가</b> 알림이 이 텔레그램에 연결됐어요.\n품절 상품에 재입고 알림을 걸면 여기로 알려드릴게요.',
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
    linked: '🔗 <b>Scent Price Finder</b> alerts are now linked to this Telegram chat.',
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
  const priceLine = price != null ? `${money(price, w.currency)}${krw(price, w.rate) ? ` (${t.approx} ${krw(price, w.rate)})` : ''}` : '';
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
