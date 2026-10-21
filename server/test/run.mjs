// 재입고 알림 서버 테스트 (가짜 쇼핑몰·텔레그램·Resend, 실제 SQL 은 node:sqlite 로 실행)
// 실행: node test/run.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker, { runChecks, messageFor } from '../src/index.js';

// ── D1 흉내 ──
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.run())), raw: db };
}

// ── 가짜 인터넷 ──
const shop = {
  variants: [{ id: 111, public_title: '100ml', price: 25000, available: false }, { id: 222, public_title: '50ml', price: 15000, available: true }],
};
let htmlOffers = [
  { '@type': 'Offer', name: '50ml', price: '120.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  { '@type': 'Offer', name: '100ml', price: '180.00', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
];
const sent = { telegram: [], email: [] };
let fetchCount = 0;
let blockedHtml = true;
globalThis.fetch = async (input, init = {}) => {
  fetchCount++;
  const url = String(input);
  if (url.startsWith('https://api.telegram.org/')) {
    if (url.includes('/getUpdates')) {
      return Response.json({ ok: true, result: [{ update_id: 1, message: { chat: { id: 4242, type: 'private', first_name: '태경' }, text: '/start' } }] });
    }
    sent.telegram.push(JSON.parse(init.body).text);
    return Response.json({ ok: true });
  }
  if (url === 'https://api.resend.com/emails') {
    const b = JSON.parse(init.body);
    sent.email.push(b);
    return Response.json({ id: 'e1' });
  }
  if (url === 'https://shop.example/products/naxos.js') return Response.json({ title: 'Naxos', handle: 'naxos', variants: shop.variants });
  if (url.startsWith('https://shop.example/products/') && url.endsWith('.js')) return new Response('Not found', { status: 404 });
  if (url.startsWith('https://blocked.example/')) {
    return new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 });
  }
  if (url.startsWith('https://html.example/')) {
    if (blockedHtml) return new Response('<title>Access Denied</title>', { status: 403 });
    const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Amouage Interlude Man', offers: htmlOffers };
    return new Response(`<html><head><title>Interlude</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>…</body></html>`, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  return new Response('nope', { status: 500 });
};

const env = { DB: fakeD1(), API_TOKEN: 'k', TELEGRAM_BOT_TOKEN: 't', RESEND_API_KEY: 'r', EMAIL_TO: 'me@example.com' };
const call = async (method, path, body, token = 'k') => {
  const r = await worker.fetch(new Request(`https://w.example${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json() };
};
const ok = (name) => console.log('✓', name);

// 1. 접속 키
assert.equal((await call('GET', '/api/status', null, 'wrong')).status, 401); ok('wrong key → 401');
let st = await call('GET', '/api/status');
assert.equal(st.body.telegram, false); assert.equal(st.body.email, true); assert.equal(st.body.emailTo, 'me*@example.com'); ok('status before link');

// 2. 텔레그램 연결
let r = await call('POST', '/api/telegram/link', { lang: 'ko' });
assert.equal(r.body.ok, true); assert.equal(r.body.name, '태경'); assert.equal(sent.telegram.length, 1);
st = await call('GET', '/api/status'); assert.equal(st.body.telegram, true); ok('telegram link + linked message');

// 3. Shopify 품절 옵션 등록 → 확인 메시지 (텔레그램 + 메일, 사이트명·향수명 포함)
const naxos = { url: 'https://shop.example/products/naxos?variant=111', storeId: 'pb', storeName: 'Perfume Box', title: 'Naxos', vendor: 'Xerjoff', variant: '100ml', size: 100, category: 'boxed', price: 250, currency: 'USD', rate: 1400, lang: 'ko' };
r = await call('POST', '/api/watches', naxos);
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.watch.kind, 'shopify');
assert.deepEqual(r.body.sent, { telegram: 'ok', email: 'ok' });
const confirmTg = sent.telegram.at(-1), confirmMail = sent.email.at(-1);
assert.match(confirmTg, /재입고 알림 설정 완료/); assert.match(confirmTg, /Perfume Box/); assert.match(confirmTg, /Xerjoff Naxos/); assert.match(confirmTg, /₩350,000/);
assert.match(confirmMail.subject, /Perfume Box · Xerjoff Naxos/); assert.deepEqual(confirmMail.to, ['me@example.com']);
ok('register sold-out Shopify variant + confirmation');
console.log('\n--- 확인 메시지 (텔레그램) ---\n' + confirmTg + '\n--- 메일 제목: ' + confirmMail.subject + '\n');

// 4. 중복·재고 있음·차단·잘못된 요청
assert.equal((await call('POST', '/api/watches', naxos)).body.duplicate, true); ok('duplicate');
r = await call('POST', '/api/watches', { ...naxos, url: 'https://shop.example/products/naxos?variant=222' });
assert.equal(r.status, 409); assert.equal(r.body.error, 'inStock'); ok('already in stock → 409');
r = await call('POST', '/api/watches', { ...naxos, url: 'https://blocked.example/p/1' });
assert.equal(r.status, 422); assert.equal(r.body.error, 'blocked'); ok('bot-blocked site → 422 blocked');
assert.equal((await call('POST', '/api/watches', { url: 'http://x' })).status, 400); ok('bad request');

// 5. HTML(JSON-LD) 상품: 차단 → 422, 풀리면 용량으로 옵션 매칭
r = await call('POST', '/api/watches', { url: 'https://html.example/interlude', storeName: 'Some Store', title: 'Interlude Man', vendor: 'Amouage', variant: '', size: 100, category: 'boxed', price: 180, currency: 'USD', rate: 1400 });
assert.equal(r.body.error, 'blocked'); blockedHtml = false;
r = await call('POST', '/api/watches', { url: 'https://html.example/interlude', storeName: 'Some Store', title: 'Interlude Man', vendor: 'Amouage', variant: '', size: 100, category: 'boxed', price: 180, currency: 'USD', rate: 1400 });
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.watch.kind, 'html'); assert.ok(!r.body.watch.loose);
ok('html JSON-LD, 100ml offer matched by size (50ml in stock ignored)');

// 6. 1분 확인: 변화 없음 → 알림 없음
let before = sent.telegram.length;
let sum = await runChecks(env, Date.now());
assert.equal(sum.checked, 2); assert.equal(sum.restocked, 0); assert.equal(sent.telegram.length, before); ok('no change → no alert');

// 7. 재입고 → 한 번만 알림, 다시 품절 → 감시 재개, 또 재입고 → 또 알림
shop.variants[0].available = true; shop.variants[0].price = 23900;
sum = await runChecks(env, Date.now());
assert.equal(sum.restocked, 1); const restockMsg = sent.telegram.at(-1);
assert.match(restockMsg, /재입고!/); assert.match(restockMsg, /\$239\.00/); assert.match(restockMsg, /바로 구매하기/); assert.match(sent.email.at(-1).subject, /재입고! — Perfume Box/);
console.log('--- 재입고 메시지 (텔레그램) ---\n' + restockMsg + '\n');
before = sent.telegram.length;
await runChecks(env, Date.now()); assert.equal(sent.telegram.length, before); ok('restock alert once');
shop.variants[0].available = false; await runChecks(env, Date.now());
shop.variants[0].available = true; sum = await runChecks(env, Date.now());
assert.equal(sum.restocked, 1); ok('sold out again → alert again on next restock');

// 8. HTML 상품 재입고 (100ml 만 봄)
htmlOffers[1].availability = 'https://schema.org/InStock';
sum = await runChecks(env, Date.now()); assert.equal(sum.restocked, 1); assert.match(sent.telegram.at(-1), /Some Store/); ok('html restock');

// 9. 계속 실패 → 6시간 뒤 한 번만 경고
blockedHtml = true; htmlOffers[1].availability = 'https://schema.org/OutOfStock';
const t0 = Date.now();
await runChecks(env, t0);
before = sent.telegram.length;
await runChecks(env, t0 + 3 * 3600e3); assert.equal(sent.telegram.length, before);
await runChecks(env, t0 + 6 * 3600e3 + 1000); assert.equal(sent.telegram.length, before + 1); assert.match(sent.telegram.at(-1), /실패/);
await runChecks(env, t0 + 7 * 3600e3); assert.equal(sent.telegram.length, before + 1); ok('persistent failure → one warning after 6h');
blockedHtml = false;

// 10. 무료 한도: 상품 40개 → 1분에 25개까지만, 다음 분에 나머지
for (let i = 0; i < 38; i++) {
  env.DB.raw.prepare('INSERT INTO watches (id, url, data, created_at) VALUES (?, ?, ?, ?)').run(`x${i}`, `https://shop.example/products/naxos?variant=111&i=${i}`,
    JSON.stringify({ id: `x${i}`, url: `https://shop.example/products/naxos?variant=111&i=${i}`, kind: 'shopify', storeName: 'S', title: 'T', currency: 'USD', inStock: true, createdAt: i }), i);
}
fetchCount = 0;
sum = await runChecks(env, 60000 * 5);
assert.ok(sum.checked <= 25, `checked ${sum.checked}`); assert.ok(fetchCount <= 44, `fetches ${fetchCount}`); ok(`budget: ${sum.checked} checked, ${fetchCount} requests in one run (limit 50)`);
const seen = new Set();
for (let m = 0; m < 3; m++) {
  const all = (await call('GET', '/api/watches')).body.watches;
  await runChecks(env, 60000 * (100 + m));
  const after = (await call('GET', '/api/watches')).body.watches;
  after.forEach(w => { const b = all.find(x => x.id === w.id); if (b && w.checkedAt !== b.checkedAt) seen.add(w.id); });
}
assert.ok(seen.size >= 38, `rotation covered ${seen.size}`); ok('rotation covers all watches within a few minutes');

// 11. 목록·삭제·테스트
let list = (await call('GET', '/api/watches')).body.watches;
assert.equal((await call('DELETE', `/api/watches/${list[0].id}`)).body.removed, 1); ok('delete');
r = await call('POST', '/api/test', { lang: 'ko' }); assert.deepEqual(r.body.sent, { telegram: 'ok', email: 'ok' }); ok('test alert');
const lr = (await call('GET', '/api/status')).body.lastRun; assert.ok(lr && lr.at); ok('last run recorded');

// 12. 영어 문구
const en = messageFor({ lang: 'en', storeName: 'Aura', title: 'Interlude', vendor: 'Amouage', variant: '3.4 oz / Tester', size: 100, category: 'tester', price: 145, currency: 'USD', rate: 1400, url: 'https://a.example/p' }, 'watch');
assert.match(en.text, /Restock alert is set/); ok('english message');
console.log('\nall passed');
