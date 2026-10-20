// 사이트별 검색 방식
// 결과 형식: { title, variant, vendor, type, price, priceMax?, partial?, currency, available, url, image }

import { defaultSearchUrl } from './stores.js';
import { relevance } from './classify.js';

const TIMEOUT_MS = 15000;
const MAX_SHOPIFY_DETAIL = 8;
const MAX_HTML_PRODUCT_PAGES = 4;

// 봇 확인 페이지 제목 (Cloudflare, Akamai, PerimeterX, DataDome 등)
export const CHALLENGE_TITLE = /just a moment|attention required|access denied|verify(ing)? you are (a )?human|checking your browser|pardon our interruption|are you a robot|security check|request blocked/i;
const BLOCK_CODES = /^HTTP (401|403|406|429|503)$/;

export const isBlockedError = code => !!code && (code === 'blocked' || BLOCK_CODES.test(code));

async function request(url, kind = 'text', { timeout = TIMEOUT_MS, credentials = 'omit' } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      credentials,
      redirect: 'follow',
      headers: { Accept: kind === 'json' ? 'application/json, text/javascript, */*' : 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (kind === 'json') {
      try { return JSON.parse(text); } catch {
        throw new Error(CHALLENGE_TITLE.test(text.slice(0, 3000)) ? 'blocked' : 'notjson');
      }
    }
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    // 응답 없이 바로 실패 = 네트워크 오류 또는 Safari 가 확장의 사이트 접근을 막음
    if (e.name === 'TypeError') throw new Error('network');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const abs = (url, base) => {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  try { return new URL(url, base).href; } catch { return url; }
};

const num = v => {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const m = String(v).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      try { out[idx] = await fn(list[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────── Shopify ─────────────────
// products: suggest.json 결과, details: /products/{handle}.js 결과(실패는 null)
// detail 은 .js(가격: 센트 정수) 또는 .json({product:{variants:[{price:"18.99"}]}}) 형식 모두 처리
export function shopifyItems(base, products, details, currency) {
  const items = [];
  products.forEach((p, idx) => {
    let d = details[idx];
    const fromJson = !!(d && d.product);
    if (fromJson) d = d.product;
    if (d && Array.isArray(d.variants) && d.variants.length) {
      const img = abs(d.featured_image || d.image?.src || p.image, base);
      for (const v of d.variants) {
        const vt = (v.public_title || v.title || '').replace(/^Default Title$/i, '');
        items.push({
          title: d.title, variant: vt, vendor: d.vendor || p.vendor || '', type: d.type || d.product_type || p.type || '',
          price: fromJson ? num(v.price) : v.price / 100, currency,
          // .json 에는 옵션별 재고 정보가 없어서 상품 전체 재고로 대신함
          available: fromJson ? !!p.available : !!v.available,
          url: `${base}/products/${d.handle || p.handle}?variant=${v.id}`,
          image: abs(v.featured_image?.src, base) || img,
        });
      }
    } else {
      // 옵션별 정보를 못 받음 → suggest 의 최저 옵션가만 알 수 있음. 정품으로 오인하지 않도록 partial 표시
      const min = num(p.price_min ?? p.price);
      const max = num(p.price_max ?? p.price);
      items.push({
        title: p.title, variant: '', vendor: p.vendor || '', type: p.type || '',
        price: min, priceMax: max > min ? max : undefined, partial: true, currency, available: !!p.available,
        url: abs(String(p.url || `/products/${p.handle}`).split('?')[0], base),
        image: abs(p.image || p.featured_image?.url, base),
      });
    }
  });
  return items;
}

const shopCurrency = new Map();
async function shopifyCurrency(base, credentials) {
  if (shopCurrency.has(base)) return shopCurrency.get(base);
  let cur = null;
  try {
    const cart = await request(`${base}/cart.js`, 'json', { timeout: 8000, credentials });
    cur = cart && cart.currency;
  } catch { /* 무시 */ }
  shopCurrency.set(base, cur);
  return cur;
}

async function shopifyDetail(base, handle, credentials) {
  try { return await request(`${base}/products/${handle}.js`, 'json', { timeout: 10000, credentials }); } catch { /* 재시도 */ }
  await sleep(700);
  try { return await request(`${base}/products/${handle}.json`, 'json', { timeout: 10000, credentials }); } catch { return null; }
}

async function shopify(store, q, ctx) {
  const base = `https://${store.domain}`;
  const url = `${base}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`;
  const data = await request(url, 'json', { credentials: ctx.credentials });
  const products = data?.resources?.results?.products;
  if (!Array.isArray(products)) throw new Error('notshopify');
  const currency = (await shopifyCurrency(base, ctx.credentials)) || ctx.regionCurrency;
  // 검색어와 관련 높은 상품부터 용량별 정보를 받음 (찾는 향수가 검색 결과 9번째 이후에 있어도 빠지지 않게)
  const ranked = products
    .map((p, i) => ({ p, i, rel: relevance(q, p.title, p.vendor || '') }))
    .sort((a, b) => b.rel - a.rel || a.i - b.i)
    .map(x => x.p);
  // 차단을 피하려고 상세 요청은 동시에 2개까지만
  const details = await mapLimit(ranked.slice(0, MAX_SHOPIFY_DETAIL), 2, p => shopifyDetail(base, p.handle, ctx.credentials));
  return shopifyItems(base, ranked, details, currency);
}

// ───────────────── WooCommerce ─────────────────
export function wooItems(data, regionCurrency) {
  return data.map(p => {
    const minor = Number(p.prices?.currency_minor_unit ?? 2);
    return {
      title: decodeHtml(p.name), variant: '', vendor: '', type: (p.categories || []).map(c => c.name).join(' '),
      price: Number(p.prices?.price) / Math.pow(10, minor),
      currency: p.prices?.currency_code || regionCurrency,
      available: p.is_in_stock !== false,
      url: p.permalink,
      image: p.images?.[0]?.thumbnail || p.images?.[0]?.src || '',
    };
  });
}

async function woo(store, q, ctx) {
  const base = `https://${store.domain}`;
  const data = await request(`${base}/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=24`, 'json', { credentials: ctx.credentials });
  if (!Array.isArray(data)) throw new Error('notwoo');
  return wooItems(data, ctx.regionCurrency);
}

function decodeHtml(s = '') {
  if (!/[&<]/.test(s)) return s;
  const d = new DOMParser().parseFromString(`<!doctype html><html><body><div>${s}</div></body></html>`, 'text/html');
  return (d.querySelector('div')?.textContent ?? s).trim() || s;
}

// ───────────────── HTML (구조화 데이터) ─────────────────
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, visit)); return; }
  visit(node);
  for (const k of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant', 'isVariantOf']) {
    if (node[k]) walk(node[k], visit);
  }
}

const hasType = (node, t) => {
  const ty = node['@type'];
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
};

function parseJsonLd(doc, base, ctx) {
  const items = [];
  const seen = new Set();
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    let json;
    try { json = JSON.parse(s.textContent.replace(/[\u0000-\u001f]/g, ' ')); } catch { return; }
    walk(json, node => {
      if (!hasType(node, 'Product')) return;
      const title = node.name || '';
      const vendor = typeof node.brand === 'string' ? node.brand : (node.brand?.name || '');
      const image = abs(Array.isArray(node.image) ? (node.image[0]?.url || node.image[0]) : (node.image?.url || node.image), base);
      const pUrl = abs(node.url || node['@id'], base);
      let offers = node.offers;
      if (!offers) return;
      offers = Array.isArray(offers) ? offers : [offers];
      const flat = [];
      for (const o of offers) {
        if (hasType(o, 'AggregateOffer') && Array.isArray(o.offers)) flat.push(...o.offers);
        else flat.push(o);
      }
      for (const o of flat) {
        const price = num(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
        if (!(price > 0)) continue;
        const avail = String(o.availability || '');
        const item = {
          title, variant: o.name && o.name !== title ? o.name : (node.size || ''), vendor, type: node.category || '',
          price, currency: o.priceCurrency || o.priceSpecification?.priceCurrency || ctx.regionCurrency,
          available: avail ? /InStock|LimitedAvailability|OnlineOnly|PreOrder/i.test(avail) : true,
          url: abs(o.url, base) || pUrl || base, image,
        };
        const key = `${item.title}|${item.variant}|${item.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    });
  });
  return items;
}

function parseMicrodata(doc, base, ctx) {
  const items = [];
  doc.querySelectorAll('[itemscope][itemtype*="schema.org/Product"]').forEach(el => {
    const get = p => {
      const n = el.querySelector(`[itemprop="${p}"]`);
      return n ? (n.getAttribute('content') || n.getAttribute('href') || n.getAttribute('src') || n.textContent.trim()) : '';
    };
    const price = num(get('price') || get('lowPrice'));
    if (!(price > 0)) return;
    const avail = get('availability');
    items.push({
      title: get('name'), variant: '', vendor: get('brand'), type: '',
      price, currency: get('priceCurrency') || ctx.regionCurrency,
      available: avail ? /InStock/i.test(avail) : true,
      url: abs(get('url') || el.querySelector('a[href]')?.getAttribute('href'), base) || base,
      image: abs(get('image'), base),
    });
  });
  return items;
}

async function html(store, q, ctx) {
  const searchUrl = ctx.searchUrl.replace('{q}', encodeURIComponent(q));
  const text = await request(searchUrl, 'text', { credentials: ctx.credentials });
  const doc = new DOMParser().parseFromString(text, 'text/html');
  // 정상 페이지에도 Cloudflare 스크립트가 들어 있을 수 있어서, 제목으로만 확인 페이지를 판별
  if (CHALLENGE_TITLE.test(doc.title || '')) throw new Error('blocked');
  const base = searchUrl;
  let items = parseJsonLd(doc, base, ctx);
  if (!items.length) items = parseMicrodata(doc, base, ctx);
  if (!items.length && store.productPattern) {
    const re = new RegExp(store.productPattern);
    // 검색어와 관련 있는 상품 링크만 열어봄 (링크 글자에 브랜드가 빠지는 경우가 많아서 주변 글자까지 함께 봄)
    const ctx = a => [a.textContent, a.parentElement?.textContent, a.parentElement?.parentElement?.textContent]
      .map(t => (t || '').replace(/\s+/g, ' ').trim()).find(t => t.length > 3 && t.length < 300) || '';
    const productLinks = [...doc.querySelectorAll('a[href]')]
      .map(a => ({ href: abs(a.getAttribute('href'), base).split('#')[0], text: ctx(a) }))
      .filter(l => re.test(l.href));
    const links = [...new Set(productLinks.filter(l => relevance(q, l.text) >= 0.75).map(l => l.href))].slice(0, MAX_HTML_PRODUCT_PAGES);
    // 상품 목록은 나왔는데 관련 상품이 없으면 = 이 사이트엔 없음 (직접 확인할 필요 없음)
    if (!links.length && productLinks.length) { const none = []; none.searched = true; return none; }
    const pages = await mapLimit(links, 4, async link => {
      const t = await request(link, 'text', { timeout: 12000, credentials: ctx.credentials });
      const d = new DOMParser().parseFromString(t, 'text/html');
      const got = parseJsonLd(d, link, ctx);
      return got.length ? got : parseMicrodata(d, link, ctx);
    });
    items = pages.filter(Boolean).flat();
  }
  return items;
}

const ADAPTERS = { shopify, woo, html };

// mode: 'shopify' | 'woo' | 'html' | 'link'(데이터 없음, 직접 확인 필요) | 'error'
// blocked: 봇 차단으로 판단되면 true
// Safari 가 확장의 웹사이트 접근을 허용했는지 확인.
// CORS 를 허용하지 않는 일반 사이트 두 곳에 요청해서, 둘 다 응답 없이 실패하면 권한이 없는 것.
export async function checkSiteAccess() {
  const probes = ['https://perfumebox.com/cart.js', 'https://www.jomashop.com/robots.txt'];
  const results = await Promise.all(probes.map(async u => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try { await fetch(u, { credentials: 'omit', signal: ctl.signal }); return 'ok'; }
    catch (e) { return e.name === 'AbortError' ? 'timeout' : 'blocked'; }
    finally { clearTimeout(timer); }
  }));
  return results.includes('ok') ? 'ok' : results.every(r => r === 'blocked') ? 'blocked' : 'unknown';
}

export async function searchStore(store, q, { detected, searchUrlOverride, regionCurrency }) {
  const searchUrl = searchUrlOverride || defaultSearchUrl(store);
  // 기본은 쿠키 없이 요청 (v1.1 에서 잘 되던 방식). 쿠키를 붙이면 Safari 에서 정상 몰까지 실패하는 경우가 있어서,
  // 차단 응답을 받았을 때만 쿠키를 붙여 한 번 더 시도
  const ctx = { searchUrl, regionCurrency, credentials: 'omit' };
  let order;
  if (store.type === 'auto') order = detected ? [detected] : ['shopify', 'woo', 'html'];
  else order = [store.type];

  let lastErr = null;
  let sawBlock = false;
  const run = async mode => {
    try {
      return await ADAPTERS[mode](store, q, ctx);
    } catch (e) {
      if (!isBlockedError(e.message)) throw e;
      return await ADAPTERS[mode](store, q, { ...ctx, credentials: 'include' });
    }
  };
  for (const mode of order) {
    try {
      const items = await run(mode);
      const clean = items.filter(i => i && i.title && Number.isFinite(i.price) && i.price > 0);
      if (mode === 'html' && !clean.length && !items.searched) return { items: [], mode: 'link', blocked: sawBlock, detected: null };
      return { items: clean, mode, detected: store.type === 'auto' ? mode : null };
    } catch (e) {
      lastErr = e;
      if (isBlockedError(e.message)) sawBlock = true;
    }
  }
  // 저장된 판별 결과로 실패했으면 다음 번엔 다시 판별
  return {
    items: [], mode: 'error', error: sawBlock ? 'blocked' : (lastErr ? lastErr.message : 'unknown'),
    blocked: sawBlock, detected: null, resetDetected: !!detected,
  };
}
