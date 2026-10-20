// 사이트별 검색 방식
// 결과 형식: { title, variant, vendor, type, price, currency, available, url, image }

import { defaultSearchUrl } from './stores.js';

const TIMEOUT_MS = 15000;
const MAX_SHOPIFY_DETAIL = 8;
const MAX_HTML_PRODUCT_PAGES = 4;

async function request(url, kind = 'text', timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: kind === 'json' ? 'application/json, text/javascript, */*' : 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (kind === 'json') {
      const text = await res.text();
      try { return JSON.parse(text); } catch { throw new Error('notjson'); }
    }
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const abs = (url, base) => {
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

// ───────────────── Shopify ─────────────────
const shopCurrency = new Map();
async function shopifyCurrency(base) {
  if (shopCurrency.has(base)) return shopCurrency.get(base);
  let cur = null;
  try {
    const cart = await request(`${base}/cart.js`, 'json', 8000);
    cur = cart && cart.currency;
  } catch { /* 무시 */ }
  shopCurrency.set(base, cur);
  return cur;
}

async function shopify(store, q, ctx) {
  const base = `https://${store.domain}`;
  const url = `${base}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`;
  const data = await request(url, 'json');
  const products = data?.resources?.results?.products;
  if (!Array.isArray(products)) throw new Error('notshopify');
  const currency = (await shopifyCurrency(base)) || ctx.regionCurrency;

  const details = await mapLimit(products.slice(0, MAX_SHOPIFY_DETAIL), 4,
    p => request(`${base}/products/${p.handle}.js`, 'json', 10000));

  const items = [];
  products.forEach((p, idx) => {
    const d = details[idx];
    if (d && Array.isArray(d.variants) && d.variants.length) {
      const img = abs(d.featured_image || p.image, base);
      for (const v of d.variants) {
        const vt = (v.public_title || v.title || '').replace(/^Default Title$/i, '');
        items.push({
          title: d.title, variant: vt, vendor: d.vendor || p.vendor || '', type: d.type || p.type || '',
          price: v.price / 100, currency, available: !!v.available,
          url: `${base}/products/${d.handle}?variant=${v.id}`,
          image: abs(v.featured_image?.src, base) || img,
        });
      }
    } else {
      items.push({
        title: p.title, variant: '', vendor: p.vendor || '', type: p.type || '',
        price: num(p.price), currency, available: !!p.available,
        url: abs(String(p.url || `/products/${p.handle}`).split('?')[0], base),
        image: abs(p.image || p.featured_image?.url, base),
      });
    }
  });
  return items;
}

// ───────────────── WooCommerce ─────────────────
async function woo(store, q, ctx) {
  const base = `https://${store.domain}`;
  const data = await request(`${base}/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=24`, 'json');
  if (!Array.isArray(data)) throw new Error('notwoo');
  return data.map(p => {
    const minor = Number(p.prices?.currency_minor_unit ?? 2);
    return {
      title: decodeHtml(p.name), variant: '', vendor: '', type: (p.categories || []).map(c => c.name).join(' '),
      price: Number(p.prices?.price) / Math.pow(10, minor),
      currency: p.prices?.currency_code || ctx.regionCurrency,
      available: p.is_in_stock !== false,
      url: p.permalink,
      image: p.images?.[0]?.thumbnail || p.images?.[0]?.src || '',
    };
  });
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
  const text = await request(searchUrl, 'text');
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const base = searchUrl;
  let items = parseJsonLd(doc, base, ctx);
  if (!items.length) items = parseMicrodata(doc, base, ctx);
  if (!items.length && store.productPattern) {
    const re = new RegExp(store.productPattern);
    const links = [...new Set([...doc.querySelectorAll('a[href]')]
      .map(a => abs(a.getAttribute('href'), base).split('#')[0])
      .filter(h => re.test(h)))].slice(0, MAX_HTML_PRODUCT_PAGES);
    const pages = await mapLimit(links, 4, async link => {
      const t = await request(link, 'text', 12000);
      const d = new DOMParser().parseFromString(t, 'text/html');
      const got = parseJsonLd(d, link, ctx);
      return got.length ? got : parseMicrodata(d, link, ctx);
    });
    items = pages.filter(Boolean).flat();
  }
  if (!items.length && /cf-chl|challenge-platform|captcha|Access Denied/i.test(text)) throw new Error('blocked');
  return items;
}

const ADAPTERS = { shopify, woo, html };

// mode: 'shopify' | 'woo' | 'html' | 'link'(직접 확인 필요)
export async function searchStore(store, q, { detected, searchUrlOverride, regionCurrency }) {
  const searchUrl = searchUrlOverride || defaultSearchUrl(store);
  const ctx = { searchUrl, regionCurrency };
  let order;
  if (store.type === 'auto') order = detected ? [detected] : ['shopify', 'woo', 'html'];
  else order = [store.type];

  let lastErr = null;
  for (const mode of order) {
    try {
      const items = await ADAPTERS[mode](store, q, ctx);
      const clean = items.filter(i => i && i.title && Number.isFinite(i.price) && i.price > 0);
      if (mode === 'html' && !clean.length) return { items: [], mode: 'link', detected: store.type === 'auto' ? 'html' : null };
      return { items: clean, mode, detected: store.type === 'auto' ? mode : null };
    } catch (e) {
      lastErr = e;
    }
  }
  // 저장된 판별 결과로 실패했으면 다음 번엔 다시 판별
  return { items: [], mode: 'error', error: lastErr ? lastErr.message : 'unknown', detected: null, resetDetected: !!detected };
}
