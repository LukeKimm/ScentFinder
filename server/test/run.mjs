// 재입고 알림 서버 테스트 — 여러 사용자, 앱에서 직접 등록
// 가짜 쇼핑몰·텔레그램·Resend 를 쓰고, SQL 은 node:sqlite 로 실제 실행
// 실행: node test/run.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import worker, { runChecks, messageFor } from '../src/index.js';

// ── D1 흉내 ──
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const norm = a => a.map(v => (v === undefined ? null : v));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, norm(a)),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); }, raw: db };
}

// ── 가짜 인터넷 ──
const OWNER = 'owner@example.com';   // Resend 가입 메일 (도메인 인증 전에는 여기로만 발송 가능)
const shop = {
  variants: [{ id: 111, public_title: '100ml', price: 25000, available: false }, { id: 222, public_title: '50ml', price: 15000, available: true }],
};
const net = { telegram: [], email: [], tgCalls: [], shopFetches: 0, tgBlocked: new Set() };
let blockedHtml = false;
const htmlOffers = [
  { '@type': 'Offer', name: '50ml', price: '120.00', availability: 'https://schema.org/InStock' },
  { '@type': 'Offer', name: '100ml', price: '180.00', availability: 'https://schema.org/OutOfStock' },
];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop();
    net.tgCalls.push(method);
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'scent_alert_bot' } });
    if (method === 'setWebhook') { net.webhook = body; return Response.json({ ok: true, result: true }); }
    if (method === 'sendMessage') {
      if (net.tgBlocked.has(String(body.chat_id))) return Response.json({ ok: false }, { status: 403 });
      net.telegram.push({ chat: String(body.chat_id), text: body.text });
      return Response.json({ ok: true });
    }
  }
  if (url === 'https://api.resend.com/emails') {
    const b = JSON.parse(init.body);
    if (b.from.includes('resend.dev') && b.to[0] !== OWNER) return Response.json({ message: 'You can only send testing emails to your own email address' }, { status: 403 });
    net.email.push(b);
    return Response.json({ id: 'e' + net.email.length });
  }
  if (url === 'https://shop.example/products/naxos.js' && net.busy) { net.shopFetches++; return new Response('Too Many Requests', { status: 429 }); }
  if (url === 'https://shop.example/products/naxos.js') { net.shopFetches++; return Response.json({ title: 'Naxos', handle: 'naxos', variants: shop.variants }); }
  if (url.startsWith('https://shop.example/products/') && url.endsWith('.js')) return new Response('Not found', { status: 404 });
  if (url.startsWith('https://many.example/products/')) {
    net.shopFetches++;
    return Response.json({ title: 'X', variants: [{ id: 1, public_title: '100ml', price: 1000, available: false }] });
  }
  if (url.startsWith('https://blocked.example/')) return new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 });
  if (url.startsWith('https://html.example/')) {
    if (blockedHtml) return new Response('<title>Access Denied</title>', { status: 403 });
    const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Amouage Interlude Man', offers: htmlOffers };
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`, { status: 200 });
  }
  return new Response('nope', { status: 500 });
};

const env = { DB: fakeD1(), TELEGRAM_BOT_TOKEN: '123:abc', RESEND_API_KEY: 're_x' };
const ORIGIN = 'https://alerts.example';
const secret = createHash('sha256').update('scentfinder:' + env.TELEGRAM_BOT_TOKEN).digest('hex').slice(0, 32);
async function req(method, path, { body, key, headers = {}, raw = false } = {}) {
  const r = await worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  if (raw) return { status: r.status, text: await r.text() };
  return { status: r.status, body: await r.json() };
}
const tgSend = (chatId, text, name = '태경', sec = secret) => req('POST', '/telegram/webhook', {
  raw: true, headers: { 'X-Telegram-Bot-Api-Secret-Token': sec },
  body: { update_id: 1, message: { chat: { id: chatId, type: 'private', first_name: name }, from: { language_code: 'ko' }, text } },
});
const ok = name => console.log('✓', name);

// 1. 가입 (기기별, 자동)
const A = (await req('POST', '/api/register', { body: { lang: 'ko' } })).body;
const B = (await req('POST', '/api/register', { body: { lang: 'en' } })).body;
assert.ok(A.key && A.userId && B.key && A.key !== B.key); ok('register two devices');
assert.equal((await req('GET', '/api/me')).status, 401);
assert.equal((await req('GET', '/api/me', { key: 'nope' })).status, 401); ok('no/invalid key → 401');
let me = (await req('GET', '/api/me', { key: A.key })).body.me;
assert.equal(me.telegram, null); assert.equal(me.email, ''); assert.equal(me.emailLimited, true); ok('fresh user has no channels');

// 2. 알림 받을 곳 없이 등록 → 거부
const naxos = { url: 'https://shop.example/products/naxos?variant=111', storeId: 'pb', storeName: 'Perfume Box', title: 'Naxos', vendor: 'Xerjoff', variant: '100ml', size: 100, category: 'boxed', price: 250, currency: 'USD', rate: 1400, lang: 'ko' };
assert.equal((await req('POST', '/api/alerts', { key: A.key, body: naxos })).body.error, 'noChannel'); ok('alert without channel → noChannel');

// 3. 텔레그램 연결: 링크 받기 → 봇에서 "시작" → 연결
let st = await req('POST', '/api/telegram/start', { key: A.key });
assert.match(st.body.url, /^https:\/\/t\.me\/scent_alert_bot\?start=[0-9a-f]{24}$/);
assert.equal(net.webhook.url, ORIGIN + '/telegram/webhook'); assert.equal(net.webhook.secret_token, secret);
const codeA = st.body.url.split('start=')[1];
await req('POST', '/api/telegram/start', { key: A.key });
assert.equal(net.tgCalls.filter(m => m === 'setWebhook').length, 1); ok('telegram link URL + webhook set once automatically');
assert.equal((await tgSend(1001, `/start ${codeA}`, '태경', 'wrong')).status, 403); ok('webhook without secret → 403');
await tgSend(1001, `/start ${codeA}`);
me = (await req('GET', '/api/me', { key: A.key })).body.me;
assert.deepEqual(me.telegram, { name: '태경' }); assert.match(net.telegram.at(-1).text, /연결됐어요/); ok('/start code → linked, confirmation sent');
await tgSend(1001, `/start ${codeA}`); assert.match(net.telegram.at(-1).text, /만료/); ok('code is single-use');
await tgSend(1001, 'hello'); assert.match(net.telegram.at(-1).text, /텔레그램 연결/); ok('other text → help');

// 4. 이메일 등록 → 인증
assert.equal((await req('POST', '/api/email', { key: A.key, body: { email: 'not-an-email' } })).body.error, 'badEmail');
let em = await req('POST', '/api/email', { key: A.key, body: { email: 'friend@gmail.com' } });
assert.equal(em.body.error, 'emailDomain'); ok('before domain: other addresses → emailDomain');
em = await req('POST', '/api/email', { key: A.key, body: { email: OWNER } });
assert.equal(em.body.ok, true); assert.equal(em.body.pending, OWNER);
const verifyMail = net.email.at(-1);
assert.match(verifyMail.subject, /인증/); const link = verifyMail.text.match(/https:\/\/\S+verify\?t=\w+/)[0];
assert.equal((await req('POST', '/api/email', { key: A.key, body: { email: OWNER } })).body.error, 'tooSoon'); ok('verification email sent, resend throttled');
me = (await req('GET', '/api/me', { key: A.key })).body.me; assert.equal(me.email, ''); assert.equal(me.emailPending, OWNER);
const pg = await req('GET', link.replace(ORIGIN, ''), { raw: true });
assert.equal(pg.status, 200); assert.match(pg.text, /인증 완료/);
me = (await req('GET', '/api/me', { key: A.key })).body.me; assert.equal(me.email, OWNER); assert.equal(me.emailPending, '');
assert.equal((await req('GET', link.replace(ORIGIN, ''), { raw: true })).status, 400); ok('verify link → email active; link single-use');

// 5. 알림 등록 → 확인 메시지 (텔레그램 + 메일, 사이트명·향수명, 수신 거부 링크)
let r = await req('POST', '/api/alerts', { key: A.key, body: naxos });
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.sent, { telegram: 'ok', email: 'ok' });
assert.match(net.telegram.at(-1).text, /재입고 알림 설정 완료[\s\S]*Perfume Box[\s\S]*Xerjoff Naxos/);
assert.equal(net.email.at(-1).to[0], OWNER); assert.match(net.email.at(-1).html, /unsubscribe\?u=/); assert.ok(net.email.at(-1).headers['List-Unsubscribe']);
ok('alert added → confirmation on both channels (with unsubscribe link)');
assert.equal((await req('POST', '/api/alerts', { key: A.key, body: naxos })).body.duplicate, true); ok('duplicate');
assert.equal((await req('POST', '/api/alerts', { key: A.key, body: { ...naxos, url: 'https://shop.example/products/naxos?variant=222' } })).body.error, 'inStock'); ok('in stock → 409');
assert.equal((await req('POST', '/api/alerts', { key: A.key, body: { ...naxos, url: 'https://blocked.example/p' } })).body.error, 'blocked'); ok('bot-blocked → 422');

// 6. 다른 사용자 B (영어, 텔레그램만) 가 같은 상품
st = await req('POST', '/api/telegram/start', { key: B.key });
await tgSend(2002, `/start ${st.body.url.split('start=')[1]}`, 'Kim');
r = await req('POST', '/api/alerts', { key: B.key, body: { ...naxos, lang: 'en' } });
assert.deepEqual(r.body.sent, { telegram: 'ok', email: 'off' }); assert.match(net.telegram.at(-1).text, /Restock alert is set/);
const listA = (await req('GET', '/api/alerts', { key: A.key })).body.alerts, listB = (await req('GET', '/api/alerts', { key: B.key })).body.alerts;
assert.equal(listA.length, 1); assert.equal(listB.length, 1); assert.notEqual(listA[0].id, listB[0].id);
assert.equal((await req('DELETE', `/api/alerts/${listA[0].id}`, { key: B.key })).body.removed, 0); ok('users are isolated (own list, cannot delete others)');

// 7. 1분 확인: 같은 상품은 한 번만 확인, 재입고 → 두 사람 모두 알림 (각자 언어)
net.shopFetches = 0;
let sum = await runChecks(env, Date.now());
assert.equal(net.shopFetches, 1); assert.equal(sum.restocked, 0); ok('same URL checked once for two users');
shop.variants[0].available = true; shop.variants[0].price = 23900;
const before = net.telegram.length;
sum = await runChecks(env, Date.now());
assert.equal(sum.restocked, 2);
const newTg = net.telegram.slice(before);
assert.ok(newTg.some(m => m.chat === '1001' && /재입고!/.test(m.text) && /\$239\.00/.test(m.text)));
assert.ok(newTg.some(m => m.chat === '2002' && /Back in stock/.test(m.text)));
assert.match(net.email.at(-1).subject, /재입고! — Perfume Box/);
console.log('\n--- 재입고 메시지 ---\n' + newTg.find(m => m.chat === '1001').text + '\n');
const n2 = net.telegram.length; await runChecks(env, Date.now()); assert.equal(net.telegram.length, n2); ok('restock → both users alerted once, in their language');
shop.variants[0].available = false; await runChecks(env, Date.now());
shop.variants[0].available = true; sum = await runChecks(env, Date.now()); assert.equal(sum.restocked, 2); ok('sold out again → alerted again');

// 7-1. 429(요청 많음)는 차단이 아님: 30분 안에는 오류로 표시하지 않고, 풀리면 그대로 이어서 확인
net.busy = true;
const tb = Date.now() + 3600e3;
await runChecks(env, tb);
let la = (await req('GET', '/api/alerts', { key: A.key })).body.alerts.find(x => x.url === naxos.url);
assert.equal(la.lastError, undefined); assert.match(la.lastStatus, /^429/);
await runChecks(env, tb + 31 * 60e3);
la = (await req('GET', '/api/alerts', { key: A.key })).body.alerts.find(x => x.url === naxos.url);
assert.equal(la.lastError, 'busy');
net.busy = false;
await runChecks(env, tb + 32 * 60e3);
la = (await req('GET', '/api/alerts', { key: A.key })).body.alerts.find(x => x.url === naxos.url);
assert.equal(la.lastError, undefined); ok('429 → not "blocked"; shown only after 30 min; clears when it recovers');

// 8. HTML 상품, 계속 실패 → 6시간 뒤 한 번 경고
shop.variants[0].available = false; await runChecks(env, Date.now());
r = await req('POST', '/api/alerts', { key: A.key, body: { url: 'https://html.example/interlude', storeName: 'Some Store', title: 'Interlude Man', vendor: 'Amouage', size: 100, category: 'boxed', price: 180, currency: 'USD', rate: 1400 } });
assert.equal(r.body.alert.kind, 'html');
blockedHtml = true;
const t0 = Date.now();
await runChecks(env, t0);
const n3 = net.telegram.length;
await runChecks(env, t0 + 3 * 3600e3); assert.equal(net.telegram.length, n3);
await runChecks(env, t0 + 6 * 3600e3 + 1000); assert.equal(net.telegram.length, n3 + 1); assert.match(net.telegram.at(-1).text, /실패/);
await runChecks(env, t0 + 7 * 3600e3); assert.equal(net.telegram.length, n3 + 1); ok('persistent failure → one warning after 6h');
blockedHtml = false;

// 9. 텔레그램 /stop, 봇 차단, 메일 수신 거부
await tgSend(2002, '/stop');
assert.equal((await req('GET', '/api/me', { key: B.key })).body.me.telegram, null); ok('/stop unlinks');
const unsub = net.email.at(-1).html.match(/https:\/\/alerts\.example\/unsubscribe\?u=[^"&]+&amp;s=\w+/)[0].replace('&amp;', '&');
assert.equal((await req('GET', unsub.replace(ORIGIN, '').replace(/s=\w+/, 's=bad'), { raw: true })).status, 400);
assert.match((await req('GET', unsub.replace(ORIGIN, ''), { raw: true })).text, /메일 알림을 껐어요/);
assert.equal((await req('GET', '/api/me', { key: A.key })).body.me.email, ''); ok('unsubscribe link (signed) turns email off');
net.tgBlocked.add('1001');
await req('POST', '/api/test', { key: A.key });
assert.equal((await req('GET', '/api/me', { key: A.key })).body.me.telegram, null); ok('user blocked the bot → telegram unlinked');
assert.equal((await req('POST', '/api/test', { key: A.key })).body.error, 'noChannel'); ok('test with no channel → noChannel');

// 10. 사용자당 한도, 도메인 인증 후 아무 주소나
env.MAX_PER_USER = '2';
const C = (await req('POST', '/api/register')).body;
env.EMAIL_FROM = '향수 최저가 <alert@mydomain.com>';
assert.equal((await req('POST', '/api/email', { key: C.key, body: { email: 'friend@gmail.com' } })).body.ok, true); ok('after domain (EMAIL_FROM): any address can register');
const cLink = net.email.at(-1).text.match(/https:\/\/\S+verify\?t=\w+/)[0];
await req('GET', cLink.replace(ORIGIN, ''), { raw: true });
for (let i = 0; i < 2; i++) assert.equal((await req('POST', '/api/alerts', { key: C.key, body: { ...naxos, url: `https://many.example/products/p${i}?variant=1` } })).status, 200);
assert.equal((await req('POST', '/api/alerts', { key: C.key, body: { ...naxos, url: 'https://many.example/products/p9?variant=1' } })).body.error, 'limit'); ok('per-user limit');
delete env.MAX_PER_USER;

// 11. 무료 한도: 상품 주소 40개 → 1분에 25개까지, 몇 분 안에 전부 돌아가며 확인
for (let i = 0; i < 38; i++) {
  env.DB.raw.prepare('INSERT INTO alerts (id, user_id, url, data, created_at) VALUES (?, ?, ?, ?, ?)').run(`x${i}`, C.userId, `https://many.example/products/q${i}?variant=1`,
    JSON.stringify({ kind: 'shopify', storeName: 'S', title: 'T', currency: 'USD', inStock: false, createdAt: i }), i);
}
net.shopFetches = 0;
sum = await runChecks(env, 60000 * 5);
assert.ok(sum.checked <= 25 && net.shopFetches <= 25, `checked ${sum.checked}`); ok(`budget: ${sum.checked} URLs checked in one run`);
const seen = new Set();
for (let m = 0; m < 3; m++) {
  const pre = new Map(env.DB.raw.prepare('SELECT id, data FROM alerts').all().map(x => [x.id, JSON.parse(x.data).checkedAt]));
  await runChecks(env, 60000 * (100 + m));
  env.DB.raw.prepare('SELECT id, data FROM alerts').all().forEach(x => { if (JSON.parse(x.data).checkedAt !== pre.get(x.id)) seen.add(x.id); });
}
const seenX = [...seen].filter(id => id.startsWith('x')).length;
assert.equal(seenX, 38, `rotation covered ${seenX}/38`); ok('rotation covers all within a few minutes');

// 12. 내 정보 모두 삭제
assert.equal((await req('DELETE', '/api/me', { key: C.key })).body.ok, true);
assert.equal((await req('GET', '/api/me', { key: C.key })).status, 401);
assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM alerts WHERE user_id = ?').get(C.userId).n, 0); ok('delete my data');

// 13. 가입 횟수 제한 (IP 당 시간당 20)
let last;
for (let i = 0; i < 20; i++) last = await req('POST', '/api/register', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
assert.equal(last.status, 200);
assert.equal((await req('POST', '/api/register', { headers: { 'CF-Connecting-IP': '9.9.9.9' } })).status, 429); ok('register rate limit');

const en = messageFor({ lang: 'en', storeName: 'Aura', title: 'Interlude', vendor: 'Amouage', variant: '3.4 oz / Tester', size: 100, category: 'tester', price: 145, currency: 'USD', rate: 1400, url: 'https://a.example/p' }, 'watch');
assert.match(en.text, /Restock alert is set/); ok('english message');
console.log('\nall passed');
