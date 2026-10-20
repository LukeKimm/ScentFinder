// 막힌 사이트를 숨은(백그라운드) 탭으로 열어서 읽기
//
// 1) 사이트 검색 페이지를 실제로 열어 봇 확인(Cloudflare 등)을 브라우저가 통과하게 함
// 2) 그 페이지 안에서 같은 출처로 Shopify / WooCommerce 데이터를 요청 (쿠키가 붙어서 통과됨)
// 3) 둘 다 아니면 화면에 그려진 상품 카드(구조화 데이터 + DOM)에서 가격을 읽음
// 4) 검색 결과에 가격이 없으면 관련 상품 페이지를 최대 2개 열어서 읽음

import { defaultSearchUrl } from './stores.js';
import { shopifyItems, wooItems, abs, CHALLENGE_TITLE } from './adapters.js';
import { relevance } from './classify.js';

const api = globalThis.browser ?? globalThis.chrome;

const READY_TIMEOUT = 20000;   // 페이지 로드 + 봇 확인 대기
const EXTRACT_TIMEOUT = 15000; // 데이터 추출 대기
const MAX_PRODUCT_PAGES = 2;
const RESULT_ATTR = 'data-scentfinder-result';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function tabsSupported() {
  return !!(api?.tabs?.create && api?.scripting?.executeScript);
}

// 열어둔 탭은 검색 화면을 닫을 때도 정리
const openTabs = new Set();
const openedUrls = new Set(); // Safari 가 "페이지 열기 실패" 화면으로 바꾸면 탭 id 로 못 닫는 경우가 있어서 주소로도 정리
addEventListener('pagehide', () => { for (const id of openTabs) { try { api.tabs.remove(id); } catch { /* 무시 */ } } });

// 검색이 끝난 뒤 남아 있는 숨은 탭을 모두 닫음
export async function cleanupTabs() {
  for (const id of openTabs) { try { await api.tabs.remove(id); } catch { /* 이미 닫힘 */ } }
  openTabs.clear();
  try {
    const all = await api.tabs.query({});
    const ids = all.filter(t => !t.active && t.url && openedUrls.has(t.url)).map(t => t.id);
    if (ids.length) await api.tabs.remove(ids);
  } catch { /* 무시 */ }
  openedUrls.clear();
}

class Stopped extends Error { constructor() { super('stopped'); } }
const checkStop = signal => { if (signal && signal.aborted) throw new Stopped(); };

async function exec(tabId, func, args = []) {
  const res = await api.scripting.executeScript({ target: { tabId }, func, args });
  return res?.[0]?.result;
}

// 페이지가 다 열리고 봇 확인 화면이 끝날 때까지 대기
const HARD_BLOCK = /access denied|request blocked|forbidden/i;  // 기다려도 안 풀리는 차단

async function waitReady(tabId, deadline, signal) {
  let lastChallenge = false;
  let hardSince = 0;
  let injectFails = 0;
  const start = Date.now();
  while (Date.now() < deadline) {
    await sleep(700);
    checkStop(signal);
    let info;
    try {
      info = await exec(tabId, () => ({ rs: document.readyState, title: document.title, old: document.documentElement.hasAttribute('data-scentfinder-old'), n: document.body ? document.body.innerText.length : 0 }));
    } catch {
      // 이동 중이면 실행 실패 → 계속 대기. 8초 넘게 계속 실패하면 페이지 자체가 안 열린 것(Safari "페이지 열기 실패")
      if (++injectFails > 11) return { ok: false, error: 'pageFailed' };
      continue;
    }
    injectFails = 0;
    if (!info || info.old) continue; // 아직 이전 페이지
    lastChallenge = CHALLENGE_TITLE.test(info.title || '');
    if (info.rs === 'complete' && !lastChallenge) return { ok: true };
    // 광고·추적 스크립트 때문에 'complete' 가 늦는 무거운 페이지는 내용이 그려졌으면 진행
    if (info.rs === 'interactive' && !lastChallenge && info.n > 800 && Date.now() - start > 4000) return { ok: true };
    // "Just a moment" 같은 확인 화면은 몇 초 뒤 풀리지만, "Access Denied" 는 기다려도 안 풀려서 6초 뒤 포기
    if (info.rs === 'complete' && HARD_BLOCK.test(info.title || '')) {
      hardSince = hardSince || Date.now();
      if (Date.now() - hardSince > 6000) return { ok: false, blocked: true };
    } else hardSince = 0;
  }
  return { ok: false, blocked: lastChallenge };
}

async function navigate(tabId, url) {
  // 이전 페이지에 표시를 남겨서, 새 페이지가 뜨기 전의 화면을 읽지 않게 함
  try { await exec(tabId, () => document.documentElement.setAttribute('data-scentfinder-old', '1')); } catch { /* 무시 */ }
  await api.tabs.update(tabId, { url });
  await sleep(500);
}

// ── 페이지 안에서 실행되는 함수 (밖의 변수를 쓰면 안 됨) ──
async function pageExtract(q, mode, attr) {
  const root = document.documentElement;
  root.removeAttribute(attr);
  const done = o => root.setAttribute(attr, JSON.stringify(o));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getJSON = async u => {
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  try {
    const out = { url: location.href, title: document.title, kind: null, raw: null, items: [], links: [] };

    if (mode !== 'dom') {
      // Shopify (같은 출처 요청이라 봇 확인 쿠키가 붙음)
      try {
        const d = await getJSON(`/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`);
        const products = d && d.resources && d.resources.results && d.resources.results.products;
        if (Array.isArray(products)) {
          const details = [];
          for (const p of products.slice(0, 8)) {
            try { details.push(await getJSON(`/products/${p.handle}.js`)); } catch { details.push(null); }
          }
          let currency = null;
          try { currency = (await getJSON('/cart.js')).currency; } catch { /* 무시 */ }
          out.kind = 'shopify'; out.raw = { products, details, currency };
          done(out); return;
        }
      } catch { /* Shopify 아님 */ }
      // WooCommerce
      try {
        const d = await getJSON(`/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=24`);
        if (Array.isArray(d)) { out.kind = 'woo'; out.raw = d; done(out); return; }
      } catch { /* WooCommerce 아님 */ }
    }

    // ── 화면에서 읽기 ──
    const PRICE = /(US\$|CA\$|C\$|A\$|\$|£|€|GBP|USD|EUR|CAD)\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/;
    const OLD = /\b(was|old|compare|compare-at|strike|original|rrp|msrp|list-?price)\b/i;
    const SOLD = /(out of stock|sold out|notify me|join waiting list|unavailable|email when available)/i;
    const text = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();

    const fromLd = () => {
      const items = [];
      const walk = (n, f) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return; }
        f(n);
        ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant', 'isVariantOf'].forEach(k => n[k] && walk(n[k], f));
      };
      const isProduct = n => { const t = n['@type']; return Array.isArray(t) ? t.includes('Product') : t === 'Product'; };
      // 구조화 데이터에 용량 이름이 없을 때(예: FragranceX) 화면에서 가격 바로 위 줄을 용량 이름으로 씀
      const raw = document.body ? document.body.innerText : '';
      const labelFor = price => {
        const v = Number(price);
        if (!(v > 0)) return '';
        const p = v.toFixed(2).replace('.', '\\.');
        const m = raw.match(new RegExp('([^\\n]{2,80})\\n+[^\\n\\d]{0,4}' + p + '(?!\\d)'));
        return m ? m[1].trim() : '';
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        let j; try { j = JSON.parse(s.textContent); } catch { return; }
        walk(j, n => {
          if (!isProduct(n) || !n.offers) return;
          const offers = [].concat(n.offers).flatMap(o => (o && Array.isArray(o.offers)) ? o.offers : [o]);
          const img = Array.isArray(n.image) ? (n.image[0] && (n.image[0].url || n.image[0])) : (n.image && (n.image.url || n.image));
          for (const o of offers) {
            if (!o) continue;
            const price = String(o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price) ?? '');
            if (!price) continue;
            items.push({
              title: n.name || '',
              variant: (o.name && o.name !== n.name) ? o.name : ((offers.length > 1 && labelFor(price)) || n.size || ''),
              vendor: typeof n.brand === 'string' ? n.brand : ((n.brand && n.brand.name) || ''),
              price, currency: o.priceCurrency || '', symbol: '',
              available: o.availability ? /InStock|LimitedAvailability|OnlineOnly|PreOrder/i.test(String(o.availability)) : true,
              url: o.url || n.url || location.href, image: typeof img === 'string' ? img : '',
            });
          }
        });
      });
      return items;
    };

    const fromCards = () => {
      const items = [];
      const seen = new Set();
      const priceEls = new Set(document.querySelectorAll('[itemprop="price"], [data-price], [class*="price" i], [class*="Price"]'));
      if (priceEls.size < 2) {
        // 가격 클래스가 없는 사이트: 가격 문자열이 있는 말단 요소를 찾음
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node, n = 0;
        while ((node = w.nextNode()) && n < 600) {
          if (PRICE.test(node.nodeValue) && node.parentElement) { priceEls.add(node.parentElement); n++; }
        }
      }
      const byUrl = new Map();
      for (const el of priceEls) {
        if (el.closest('del, s, strike, header, footer, nav')) continue;
        if (OLD.test((el.className && String(el.className)) || '')) continue;
        if (!PRICE.test(text(el))) continue;
        // 상품 카드 범위: 위로 올라가며 링크가 3개 이하인 가장 큰 상자
        let card = el, best = null;
        for (let i = 0; i < 8 && card && card !== document.body; i++) {
          const hrefs = new Set([...card.querySelectorAll('a[href]')].map(a => a.href.split('#')[0]).filter(h => h && !h.startsWith('javascript')));
          const len = text(card).length;
          if (hrefs.size >= 1 && hrefs.size <= 3 && len < 700) best = card;
          if (hrefs.size > 3 || len >= 700) break;
          card = card.parentElement;
        }
        if (!best) continue;
        const links = [...best.querySelectorAll('a[href]')];
        const link = links.sort((a, b) => text(b).length - text(a).length)[0];
        if (!link) continue;
        const url = link.href.split('#')[0];
        if (byUrl.has(url) || seen.has(best)) continue;
        seen.add(best);
        const head = best.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
        const img = best.querySelector('img');
        const title = (text(head) || text(link) || (img && img.alt) || '').slice(0, 200);
        if (!title) continue;
        // 카드 안의 가격 중 정가(취소선)·할인액·배송 조건을 빼고 가장 낮은 값 = 판매가
        // 정가 표시(취소선, old/was/compare 클래스)는 빼고 읽음. Shopify 의 "regular" 는 정상가라서 빼지 않음
        const STRUCK_CLASS = /(^|[-_\s])(old|was|compare|compare-at|original|rrp|msrp|strike|crossed)([-_\s]|$)/i;
        const struck = new Set([...best.querySelectorAll('del, s, strike, [class]')]
          .filter(e => /^(DEL|S|STRIKE)$/.test(e.tagName) || STRUCK_CLASS.test(String(e.className)))
          .map(text).filter(Boolean));
        const readPrices = body => {
          const out = [];
          const re = new RegExp(PRICE.source, 'g');
          let m;
          while ((m = re.exec(body))) {
            const before = body.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
            const after = body.slice(m.index + m[0].length, m.index + m[0].length + 6).toLowerCase();
            if (/(save|over|under|spend|orders?)\s*$/.test(before) || /^\s*off/.test(after)) continue;
            const v = parseFloat(String(m[2]).replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''));
            if (v > 0) out.push({ v, raw: m[2], sym: m[1] });
          }
          return out;
        };
        let body = text(best);
        for (const st of struck) body = body.split(st).join(' ');
        let prices = readPrices(body);
        if (!prices.length) prices = readPrices(text(best));
        if (!prices.length) continue;
        prices.sort((a, b) => a.v - b.v);
        const full = text(best);
        byUrl.set(url, {
          title, variant: full.replace(title, '').slice(0, 200), vendor: '',
          price: prices[0].raw, symbol: prices[0].sym, currency: '',
          available: !SOLD.test(full), url,
          image: img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '',
          // 목록 카드 가격은 여러 용량 중 최저가일 수 있음 ("From $..", "2 sizes available", Shopify 카드 등)
          partial: mode !== 'dom' || /\b(from|starting at)\b|sizes? available|more sizes|options available/i.test(full),
        });
        if (byUrl.size >= 60) break;
      }
      items.push(...byUrl.values());
      return items;
    };

    // 자바스크립트로 늦게 그려지는 사이트를 위해 최대 10초 다시 시도.
    // 배너 가격(예: 구독 $6.95)만 잡히고 끝나지 않도록, 검색어 단어가 들어간 상품이 나올 때까지 기다림
    const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const hit = it => qWords.some(w => `${it.title} ${it.variant}`.toLowerCase().includes(w));
    const NO_RESULTS = /no results|(^|[^\d.,])0 results|no products (were )?found|nothing (was )?found|did ?n.t match any|we couldn.t find|sorry, no/i;
    for (let i = 0; i < 10; i++) {
      out.items = fromLd();
      if (!out.items.length) out.items = fromCards();
      if (out.items.some(hit)) break;
      if (i >= 1 && NO_RESULTS.test(text(document.querySelector('main') || document.body).slice(0, 4000))) { out.noResults = true; break; }
      if (i >= 3 && document.querySelectorAll('a[href]').length > 0 && [...document.querySelectorAll('a[href]')].some(a => qWords.every(w => text(a.parentElement).toLowerCase().includes(w)))) break;
      await sleep(1000);
    }
    out.title = document.title;
    // 상품 링크: 링크 글자만으로는 브랜드가 빠지는 경우가 많아서(예: "Aventus" by Creed) 카드 전체 글자를 함께 씀
    const ctxText = a => {
      let el = a;
      for (let i = 0; i < 4 && el.parentElement; i++) {
        const p = el.parentElement;
        if (text(p).length > 300 || p.querySelectorAll('a[href]').length > 4) break;
        el = p;
      }
      return text(el).slice(0, 200);
    };
    const linkMap = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href.split('#')[0];
      if (!href.startsWith(location.origin) || /\/search|[?&](q|f|query|search|text|stext|sort|page)=/i.test(href.slice(location.origin.length))) continue;
      const tx = ctxText(a) || a.title || '';
      if (!tx) continue;
      if (!linkMap.has(href) || linkMap.get(href).length < tx.length) linkMap.set(href, tx);
      if (linkMap.size >= 400) break;
    }
    out.links = [...linkMap].map(([href, t]) => ({ href, text: t }));
    out.kind = 'dom';

    // Shopify 몰은 검색 JSON 이 막혀도 상품별 /products/{handle}.js 는 열려 있는 경우가 많음.
    // 카드의 "최저 옵션가"(샘플 가격일 수 있음) 대신 용량별 실제 가격으로 바꿈
    if (mode !== 'dom') {
      const handleOf = u => { const m = String(u).match(/\/products\/([^/?#]+)/); return m ? m[1] : null; };
      const ordered = [...out.items].sort((a, b) => (hit(b) ? 1 : 0) - (hit(a) ? 1 : 0));
      const handles = [...new Set(ordered.map(i => handleOf(i.url)).filter(Boolean))].slice(0, 8);
      const products = [], details = [], got = new Set();
      for (const h of handles) {
        try {
          const d = await getJSON(`/products/${h}.js`);
          if (!d || !Array.isArray(d.variants)) continue;
          products.push({ handle: h, title: d.title, vendor: d.vendor, type: d.type, available: d.available, url: `/products/${h}`, image: d.featured_image });
          details.push(d);
          got.add(h);
        } catch { /* 이 상품은 화면 가격 그대로 */ }
      }
      if (products.length) {
        let currency = null;
        try { currency = (await getJSON('/cart.js')).currency; } catch { /* 무시 */ }
        out.kind = 'shopify';
        out.raw = { products, details, currency };
        out.items = out.items.filter(i => !got.has(handleOf(i.url)));  // 나머지는 화면 가격으로
      }
    }
    done(out);
  } catch (e) {
    done({ error: String(e && e.message || e) });
  }
}

async function runExtract(tabId, q, mode, deadline, signal) {
  // executeScript 가 비동기 함수의 결과를 돌려주지 않는 Safari 버전도 있어서, 결과는 DOM 속성으로 받음
  let injectErr = false;
  await Promise.race([exec(tabId, pageExtract, [q, mode, RESULT_ATTR]).catch(() => { injectErr = true; }), sleep(1500)]);
  // 주입 오류가 나도 함수가 이미 실행됐을 수 있어서 결과는 잠시 더 확인
  if (injectErr) deadline = Math.min(deadline, Date.now() + 5000);
  while (Date.now() < deadline) {
    checkStop(signal);
    let raw;
    try { raw = await exec(tabId, a => document.documentElement.getAttribute(a), [RESULT_ATTR]); } catch { raw = null; }
    if (raw) { try { return JSON.parse(raw); } catch { return { error: 'parse' }; } }
    await sleep(700);
  }
  return { error: 'tabTimeout' };
}

// 가격 문자열 → 숫자 ("1.234,56" 과 "1,234.56" 둘 다)
function parsePrice(s) {
  if (typeof s === 'number') return s;
  s = String(s || '').replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}
const SYMBOL_CURRENCY = { '£': 'GBP', '€': 'EUR', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'US$': 'USD', GBP: 'GBP', USD: 'USD', EUR: 'EUR', CAD: 'CAD' };

function domItems(out, regionCurrency) {
  return (out.items || []).map(i => ({
    title: i.title, variant: i.variant || '', vendor: i.vendor || '', type: '',
    price: parsePrice(i.price),
    currency: i.currency || SYMBOL_CURRENCY[i.symbol] || regionCurrency,
    available: i.available !== false,
    partial: !!i.partial || undefined,
    url: abs(i.url, out.url), image: abs(i.image, out.url),
  })).filter(i => i.title && i.price > 0);
}

function toItems(out, regionCurrency) {
  const base = new URL(out.url).origin;
  if (out.kind === 'shopify') {
    return [
      ...shopifyItems(base, out.raw.products, out.raw.details, out.raw.currency || regionCurrency),
      ...domItems(out, out.raw.currency || regionCurrency),
    ];
  }
  if (out.kind === 'woo') return wooItems(out.raw, regionCurrency);
  return domItems(out, regionCurrency);
}

/**
 * 숨은 탭으로 사이트 검색
 * @returns {{items: object[], mode: 'tab'|'link'|'error', error?: string, blocked?: boolean}}
 */
export async function searchViaTab(store, q, { searchUrlOverride, regionCurrency, relMin = 0.75, signal }) {
  if (!tabsSupported()) return { items: [], mode: 'error', error: 'noScripting' };
  if (signal && signal.aborted) return { items: [], mode: 'error', error: 'stopped' };
  const url = (searchUrlOverride || defaultSearchUrl(store)).replace('{q}', encodeURIComponent(q));
  openedUrls.add(url);
  let tab;
  try {
    tab = await api.tabs.create({ url, active: false });
  } catch {
    return { items: [], mode: 'error', error: 'noScripting' };
  }
  openTabs.add(tab.id);
  try {
    const ready = await waitReady(tab.id, Date.now() + READY_TIMEOUT, signal);
    if (!ready.ok) return { items: [], mode: 'error', error: ready.error || (ready.blocked ? 'blocked' : 'tabTimeout'), blocked: !!ready.blocked };

    const mode = store.type === 'html' ? 'dom' : 'auto';
    const out = await runExtract(tab.id, q, mode, Date.now() + EXTRACT_TIMEOUT, signal);
    if (out.noResults && !(out.items || []).length) return { items: [], mode: 'tab' };
    if (out.error) return { items: [], mode: 'error', error: out.error };
    let items = toItems(out, regionCurrency);

    // 검색 결과에 관련 상품 가격이 없으면 관련 상품 페이지를 직접 열어봄
    // (관련 상품이 없거나, 있어도 "최저 옵션가"뿐이면 상품 페이지에서 용량별 가격을 확인)
    const relevant = items.filter(i => relevance(q, i.title, i.vendor, i.variant) >= relMin);
    if (!relevant.some(i => !i.partial)) {
      const seen = new Set();
      const candidates = (out.links || [])
        .map(l => ({ ...l, rel: relevance(q, l.text) }))
        .filter(l => l.rel >= relMin && l.href !== out.url)
        .sort((a, b) => b.rel - a.rel)
        .filter(l => !seen.has(l.href) && seen.add(l.href))
        .slice(0, MAX_PRODUCT_PAGES);
      for (const c of candidates) {
        checkStop(signal);
        openedUrls.add(c.href);
        await navigate(tab.id, c.href);
        const r = await waitReady(tab.id, Date.now() + 15000, signal);
        if (!r.ok) continue;
        const page = await runExtract(tab.id, q, 'dom', Date.now() + 12000, signal);
        if (page.error) continue;
        // 상품 페이지 제목에 브랜드가 빠진 경우가 있어서(예: "Aventus Cologne"), 검색 카드 글자를 관련도 판단용으로 붙여둠
        const got = domItems(page, regionCurrency).map(i => ({ ...i, title: i.title || c.text, relHint: c.text }));
        // 상품 페이지에서 용량별 가격을 얻었으면, 같은 상품의 목록 "최저 옵션가" 항목은 뺌
        if (got.some(i => !i.partial)) {
          const path = u => { try { return new URL(u).pathname; } catch { return u; } };
          const p = path(c.href);
          items = items.filter(i => !(i.partial && path(i.url) === p));
        }
        items.push(...got);
      }
    }
    return { items, mode: items.length ? 'tab' : 'link' };
  } catch (e) {
    return { items: [], mode: 'error', error: e instanceof Stopped ? 'stopped' : 'tabTimeout' };
  } finally {
    openTabs.delete(tab.id);
    try { await api.tabs.remove(tab.id); } catch { /* 이미 닫힘 */ }
  }
}
