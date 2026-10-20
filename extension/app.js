import { DEFAULT_STORES, REGIONS, defaultSearchUrl } from './stores.js';
import { searchStore } from './adapters.js';
import { searchViaTab, tabsSupported, cleanupTabs } from './tabs.js';
import { CATEGORIES, classify, extractSize, extractConcentration, relevance, isNonFragrance } from './classify.js';
import { t, initLang, getLang, applyStatic, mountLangSwitch, numLocale } from './i18n.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);

const REGION_CURRENCY = { US: 'USD', UK: 'GBP', CA: 'CAD', EU: 'EUR', ETC: 'USD' };
const RATE_CURRENCIES = ['USD', 'GBP', 'CAD', 'EUR'];
const FALLBACK_RATES = { USD: 1400, GBP: 1850, CAD: 1000, EUR: 1600, KRW: 1 }; // API 실패 시에만 사용
const RATE_TTL = 6 * 3600 * 1000;
const CONCURRENCY = 8;
const TAB_CONCURRENCY = 3;   // 숨은 탭은 동시에 3개까지
const RELEVANCE_MIN = 0.75;

const state = {
  enabled: {},          // storeId → bool (기본 true)
  custom: [],           // 사용자 추가 사이트
  detected: {},         // storeId → 'shopify' | 'woo' | 'html'
  urlOverride: {},      // storeId → 검색 URL
  filters: { boxed: true, tester: true, unboxed: true, sample: true, set: true, soldout: false, loose: false },
  sort: 'krw',
  opts: { tabs: true },
  route: {},           // storeId → { tabFails, until } 탭 실패가 반복된 사이트는 잠시 건너뜀
  rateOverride: {},
  rates: null,          // { at, src, values: {USD: 1400, ...} }
  results: [],          // 정규화된 결과
  storeStatus: {},      // storeId → { state, count, error }
  query: '',
  running: false,
};

// ───────── 저장소 ─────────
async function load() {
  try {
    const s = await api.storage.local.get(['enabled', 'custom', 'detected', 'urlOverride', 'filters', 'sort', 'opts', 'route', 'rateOverride', 'rates']);
    Object.assign(state, {
      enabled: s.enabled || {},
      custom: s.custom || [],
      detected: s.detected || {},
      urlOverride: s.urlOverride || {},
      filters: { ...state.filters, ...(s.filters || {}) },
      sort: s.sort || 'krw',
      opts: { ...state.opts, ...(s.opts || {}) },
      route: s.route || {},
      rateOverride: s.rateOverride || {},
      rates: s.rates || null,
    });
  } catch { /* 저장소 실패 시 기본값 */ }
}
function save(...keys) {
  const o = {};
  for (const k of keys) o[k] = state[k];
  try { api.storage.local.set(o); } catch { /* 무시 */ }
}

const allStores = () => [...DEFAULT_STORES, ...state.custom];
const isOn = s => state.enabled[s.id] ?? !s.defaultOff;

// ───────── 환율 ─────────
async function ensureRates(force = false) {
  if (!force && state.rates && Date.now() - state.rates.at < RATE_TTL) return;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { credentials: 'omit' });
    const j = await res.json();
    if (j.result !== 'success' || !j.rates?.KRW) throw new Error();
    const krw = j.rates.KRW;
    const values = { KRW: 1 };
    for (const [cur, r] of Object.entries(j.rates)) values[cur] = krw / r;
    state.rates = { at: Date.now(), src: 'auto', values };
    save('rates');
  } catch {
    if (!state.rates) state.rates = { at: 0, src: 'fallback', values: { ...FALLBACK_RATES } };
  }
  renderRates();
}
function rate(cur) {
  const o = parseFloat(state.rateOverride[cur]);
  if (o > 0) return o;
  return state.rates?.values?.[cur] ?? FALLBACK_RATES[cur] ?? NaN;
}
function renderRates() {
  const box = $('rateInputs');
  box.innerHTML = '';
  for (const cur of RATE_CURRENCIES) {
    const auto = state.rates?.values?.[cur];
    const lab = document.createElement('label');
    lab.innerHTML = `<span>1 ${cur} =</span>`;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.inputMode = 'decimal'; inp.step = '0.01';
    inp.placeholder = auto ? auto.toFixed(1) : '';
    inp.value = state.rateOverride[cur] || '';
    inp.addEventListener('change', () => {
      if (inp.value) state.rateOverride[cur] = inp.value; else delete state.rateOverride[cur];
      save('rateOverride');
      renderRates();
      renderResults();
    });
    lab.appendChild(inp);
    lab.insertAdjacentHTML('beforeend', `<span>${t('rates.unit')}</span>`);
    box.appendChild(lab);
  }
  const usd = rate('USD');
  const tag = Object.keys(state.rateOverride).length ? t('rates.manual') : state.rates?.src === 'auto' ? t('rates.auto') : t('rates.default');
  $('rateInfo').textContent = `$1 ≈ ₩${Math.round(usd).toLocaleString(numLocale())} (${tag})`;
}

// ───────── 사이트 패널 ─────────
function renderStores() {
  const groups = $('storeGroups');
  groups.innerHTML = '';
  const stores = allStores();
  for (const [rid, r] of Object.entries(REGIONS)) {
    const list = stores.filter(s => s.region === rid);
    if (!list.length) continue;
    const g = document.createElement('div');
    g.className = 'group';
    const head = document.createElement('div');
    head.className = 'groupHead';
    head.innerHTML = `<span>${r.flag} ${esc(t('region.' + rid))} (${list.filter(isOn).length}/${list.length})</span>`;
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'link';
    const allOn = list.every(isOn);
    toggle.textContent = allOn ? t('stores.allOff') : t('stores.allOn');
    toggle.addEventListener('click', () => {
      list.forEach(s => { state.enabled[s.id] = !allOn; });
      save('enabled'); renderStores();
    });
    head.appendChild(toggle);
    g.appendChild(head);

    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'storeRow';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = isOn(s); cb.id = `st-${s.id}`;
      cb.addEventListener('change', () => { state.enabled[s.id] = cb.checked; save('enabled'); renderStores(); });
      const lab = document.createElement('label');
      lab.htmlFor = cb.id;
      const mode = s.type === 'auto' ? modeLabel(state.detected[s.id] || 'auto') : modeLabel(s.type);
      lab.innerHTML = `${esc(s.name)} <span class="mode">· ${mode}</span><span class="dom">${esc(s.domain)}</span>`;
      const tools = document.createElement('div');
      tools.className = 'tools';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'link'; edit.textContent = t('stores.url');
      tools.appendChild(edit);
      if (s.custom) {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'link'; del.textContent = t('stores.delete');
        del.addEventListener('click', () => {
          state.custom = state.custom.filter(c => c.id !== s.id);
          delete state.enabled[s.id]; delete state.detected[s.id]; delete state.urlOverride[s.id];
          save('custom', 'enabled', 'detected', 'urlOverride'); renderStores();
        });
        tools.appendChild(del);
      }
      row.append(cb, lab, tools);
      edit.addEventListener('click', () => {
        if (row.querySelector('.urlEdit')) { row.querySelector('.urlEdit').remove(); return; }
        const box = document.createElement('div');
        box.className = 'urlEdit';
        const inp = document.createElement('input');
        inp.value = state.urlOverride[s.id] || defaultSearchUrl(s);
        inp.title = t('stores.urlHint');
        const ok = document.createElement('button');
        ok.type = 'button'; ok.textContent = t('stores.save');
        ok.addEventListener('click', () => {
          const v = inp.value.trim();
          if (v && v !== defaultSearchUrl(s) && v.includes('{q}')) state.urlOverride[s.id] = v;
          else delete state.urlOverride[s.id];
          save('urlOverride'); box.remove();
        });
        box.append(inp, ok);
        row.appendChild(box);
      });
      g.appendChild(row);
    }
    groups.appendChild(g);
  }
  $('storeCount').textContent = `${stores.filter(isOn).length}/${stores.length}`;
}
const modeLabel = m => ({ shopify: 'Shopify', woo: 'WooCommerce', html: t('mode.html'), auto: t('mode.auto') }[m] || m);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('addName').value.trim();
  let domain = $('addDomain').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!name || !domain) return;
  const id = 'c_' + domain.replace(/[^a-z0-9]/gi, '_');
  if (allStores().some(s => s.id === id)) return;
  state.custom.push({ id, name, domain, region: $('addRegion').value, type: 'auto', custom: true });
  save('custom');
  $('addName').value = ''; $('addDomain').value = '';
  renderStores();
});
$('resetDetect').addEventListener('click', () => { state.detected = {}; state.route = {}; save('detected', 'route'); renderStores(); });

// ───────── 필터 칩 ─────────
function renderChips() {
  const box = $('catChips');
  box.innerHTML = '';
  for (const key of CATEGORIES) {
    const lab = document.createElement('label');
    lab.className = 'chip';
    lab.innerHTML = `<input type="checkbox"><span>${esc(t('cat.' + key))}</span>`;
    const cb = lab.querySelector('input');
    cb.checked = state.filters[key] !== false;
    cb.addEventListener('change', () => { state.filters[key] = cb.checked; save('filters'); renderResults(); });
    box.appendChild(lab);
  }
  $('optSoldout').checked = !!state.filters.soldout;
  $('optLoose').checked = !!state.filters.loose;
  $('sort').value = state.sort;
}
$('optSoldout').addEventListener('change', e => { state.filters.soldout = e.target.checked; save('filters'); renderResults(); });
$('optLoose').addEventListener('change', e => { state.filters.loose = e.target.checked; save('filters'); renderResults(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; save('sort'); renderResults(); });
$('size').addEventListener('change', () => renderResults());

function renderAdv() {
  $('optTabs').checked = !!state.opts.tabs && tabsSupported();
  $('optTabs').disabled = !tabsSupported();
}
$('optTabs').addEventListener('change', e => { state.opts.tabs = e.target.checked; save('opts'); });

// ───────── 검색 ─────────
function normalizeItem(raw, store, query) {
  const size = extractSize(raw.variant, raw.title);
  const category = classify(raw, size);
  return {
    ...raw,
    storeId: store.id, storeName: store.name, region: store.region,
    size, category,
    conc: extractConcentration(`${raw.title} ${raw.variant} ${raw.type}`),
    nonFrag: isNonFragrance(raw),
    rel: relevance(query, raw.title, raw.vendor, raw.variant, raw.relHint || ''),
  };
}

// 탭으로도 2번 연속 못 읽은 사이트는 3일 동안 탭을 건너뜀 (검색 시간 단축)
const ROUTE_MAX_FAILS = 2;
const ROUTE_SKIP_MS = 3 * 24 * 3600 * 1000;
const tabSkipped = id => { const r = state.route[id]; return !!(r && r.tabFails >= ROUTE_MAX_FAILS && Date.now() < r.until); };
function noteTab(id, ok) {
  if (ok) { delete state.route[id]; save('route'); return; }
  const r = state.route[id] || { tabFails: 0, until: 0 };
  r.tabFails += 1;
  if (r.tabFails >= ROUTE_MAX_FAILS) r.until = Date.now() + ROUTE_SKIP_MS;
  state.route[id] = r;
  save('route');
}

async function runSearch(query) {
  query = query.trim();
  if (!query || state.running) return;
  state.running = true;
  state.stopped = false;
  state.abort = { aborted: false };
  state.query = query;
  state.results = [];
  state.storeStatus = {};
  state.startedAt = Date.now();
  state.finishedAt = 0;
  $('size').value = '';
  history.replaceState(null, '', `?q=${encodeURIComponent(query)}`);
  document.title = `${query} · ${t('appName')}`;
  rememberRecent(query);

  const stores = allStores().filter(isOn);
  stores.forEach(s => { state.storeStatus[s.id] = { state: 'wait' }; });
  startProgressTimer();
  renderStatus();
  renderResults();

  await ensureRates();

  const signal = state.abort;
  const useTabs = state.opts.tabs && tabsSupported();
  const tabJobs = [];
  const runTab = limiter(TAB_CONCURRENCY);

  const apply = (store, res, viaTab = false) => {
    const items = res.items.map(r => normalizeItem(r, store, query));
    state.results.push(...items);
    const relevant = items.filter(i => i.rel >= RELEVANCE_MIN && !i.nonFrag).length;
    state.storeStatus[store.id] =
      res.error === 'stopped' ? { state: 'stopped' } :
      res.mode === 'error' ? (res.blocked || res.error === 'blocked' ? { state: 'blocked', error: res.error, skipped: res.skipped } : { state: 'err', error: res.error, skipped: res.skipped }) :
      res.mode === 'link' ? { state: res.blocked ? 'blocked' : 'link', error: res.blocked ? 'blocked' : '', skipped: res.skipped } :
      { state: relevant ? 'ok' : 'none', count: relevant, viaTab };
    renderStatus();
    renderResults();
  };

  const queueTab = (store, fetchRes) => {
    state.storeStatus[store.id] = { state: 'tabWait' };
    renderStatus();
    tabJobs.push(runTab(async () => {
      if (signal.aborted) { apply(store, { items: [], mode: 'error', error: 'stopped' }); return; }
      state.storeStatus[store.id] = { state: 'tab' };
      renderStatus();
      const res = await searchViaTab(store, query, {
        searchUrlOverride: state.urlOverride[store.id],
        regionCurrency: REGION_CURRENCY[store.region] || 'USD',
        relMin: RELEVANCE_MIN,
        signal,
      });
      if (res.error !== 'stopped') noteTab(store.id, res.mode === 'tab');
      // 탭으로도 못 읽으면 처음 요청의 실패 이유(봇 차단 등)를 같이 보여줌
      if (res.mode !== 'tab' && fetchRes?.blocked) res.blocked = true;
      apply(store, res, true);
    }));
  };

  let idx = 0;
  const worker = async () => {
    while (idx < stores.length) {
      const store = stores[idx++];
      if (signal.aborted) { apply(store, { items: [], mode: 'error', error: 'stopped' }); continue; }
      const canTab = useTabs && !tabSkipped(store.id);
      if (store.tabOnly && canTab) { queueTab(store, null); continue; }
      const res = await searchStore(store, query, {
        detected: state.detected[store.id],
        searchUrlOverride: state.urlOverride[store.id],
        regionCurrency: REGION_CURRENCY[store.region] || 'USD',
      });
      if (res.detected && state.detected[store.id] !== res.detected) { state.detected[store.id] = res.detected; save('detected'); }
      if (res.resetDetected) { delete state.detected[store.id]; save('detected'); }
      const failed = res.mode === 'error' || res.mode === 'link';
      if (failed && canTab && !signal.aborted) queueTab(store, res);
      else apply(store, failed && useTabs && tabSkipped(store.id) ? { ...res, skipped: true } : res);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stores.length) }, worker));
  await Promise.all(tabJobs);
  await cleanupTabs();

  state.running = false;
  state.stopped = signal.aborted;
  state.finishedAt = Date.now();
  stopProgressTimer();
  document.title = `${query} · ${t('appName')}`;
  renderStores();
  renderStatus();
  renderResults();
}

// ───────── 진행 상태 ─────────
let progressTimer = null;
function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(renderProgress, 1000);
}
function stopProgressTimer() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}
function renderProgress() {
  const box = $('progress');
  const entries = Object.values(state.storeStatus);
  if (!state.query || !entries.length) { box.hidden = true; return; }
  box.hidden = false;
  const total = entries.length;
  const pending = entries.filter(e => e.state === 'wait' || e.state === 'tab' || e.state === 'tabWait');
  const done = total - pending.length;
  const checked = entries.filter(e => !['wait', 'tab', 'tabWait', 'stopped'].includes(e.state)).length;
  const inTab = entries.filter(e => e.state === 'tab').length;
  const tabWait = entries.filter(e => e.state === 'tabWait').length;
  const found = visibleItems().length;
  const needCheckN = entries.filter(e => ['link', 'blocked', 'err', 'stopped'].includes(e.state)).length;
  const secs = Math.round(((state.finishedAt || Date.now()) - (state.startedAt || Date.now())) / 1000);
  box.className = 'progress ' + (state.running ? 'running' : state.stopped ? 'stopped' : 'done');
  const label = state.running
    ? t('prog.running', { done, total })
    : state.stopped ? t('prog.stopped', { done: checked, total }) : t('prog.done', { total });
  const detail = state.running
    ? [inTab ? t('prog.inTab', { n: inTab }) : '', tabWait ? t('prog.tabWait', { n: tabWait }) : '', t('prog.found', { n: found }), t('prog.secs', { n: secs })].filter(Boolean).join(' · ')
    : [t('prog.found', { n: found }), needCheckN ? t('prog.needCheck', { n: needCheckN }) : '', t('prog.secs', { n: secs })].filter(Boolean).join(' · ');
  box.innerHTML = `
    <div class="progRow">
      <span class="progIcon" aria-hidden="true"></span>
      <span class="progLabel">${esc(label)}</span>
      <span class="progDetail">${esc(detail)}</span>
      ${state.running ? `<button type="button" class="progStop" id="stopBtn">${esc(t('prog.stop'))}</button>` : ''}
    </div>
    <div class="progBar"><span style="width:${total ? Math.round(done / total * 100) : 0}%"></span></div>`;
  const stop = $('stopBtn');
  if (stop) stop.addEventListener('click', () => { if (state.abort) state.abort.aborted = true; stop.disabled = true; stop.textContent = t('prog.stopping'); });
  const go = $('go');
  go.disabled = state.running;
  go.textContent = state.running ? t('search.running') : t('search.button');
  if (state.running) document.title = `(${done}/${total}) ${state.query} · ${t('appName')}`;
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve } = queue.shift();
    fn().catch(() => {}).finally(() => { active--; resolve(); next(); });
  };
  return fn => new Promise(resolve => { queue.push({ fn, resolve }); next(); });
}

async function rememberRecent(q) {
  try {
    const { recent = [] } = await api.storage.local.get('recent');
    const next = [q, ...recent.filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, 10);
    await api.storage.local.set({ recent: next });
  } catch { /* 무시 */ }
}

function storeSearchLink(store) {
  const tpl = state.urlOverride[store.id] || defaultSearchUrl(store);
  return tpl.replace('{q}', encodeURIComponent(state.query));
}

function renderStatus() {
  renderProgress();
  const box = $('status');
  const entries = Object.entries(state.storeStatus);
  if (!entries.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';
  const byId = Object.fromEntries(allStores().map(s => [s.id, s]));
  const order = { ok: 0, none: 1, tab: 2, tabWait: 3, wait: 4, link: 5, blocked: 6, err: 7, stopped: 8 };
  entries.sort((a, b) => order[a[1].state] - order[b[1].state]);
  const needCheck = [];
  for (const [id, st] of entries) {
    const s = byId[id];
    if (!s) continue;
    const live = st.state === 'wait' || st.state === 'tab' || st.state === 'tabWait';
    const el = document.createElement(live ? 'span' : 'a');
    el.className = 'st ' + st.state;
    if (!live) { el.href = storeSearchLink(s); el.target = '_blank'; el.rel = 'noopener'; }
    if (st.state === 'ok') el.textContent = `${s.name} ${st.count}${st.viaTab ? ' · ' + t('status.viaTab') : ''}`;
    else if (st.state === 'tab') el.textContent = `${s.name} · ${t('status.tab')}`;
    else if (st.state === 'tabWait') el.textContent = `${s.name} · ${t('status.tabWait')}`;
    else if (st.state === 'stopped') { el.textContent = `${s.name} · ${t('status.stopped')}`; needCheck.push(s); }
    else if (st.state === 'blocked') { el.textContent = `${s.name} · ${t('status.blocked')}${st.skipped ? ' · ' + t('status.skipped') : ''}`; el.title = errText('blocked'); needCheck.push(s); }
    else if (st.state === 'none') el.textContent = `${s.name} 0${st.viaTab ? ' · ' + t('status.viaTab') : ''}`;
    else if (st.state === 'link') { el.textContent = `${s.name} · ${t('status.check')}${st.skipped ? ' · ' + t('status.skipped') : ''}`; el.className = 'st link'; needCheck.push(s); }
    else if (st.state === 'err') { el.textContent = `${s.name} · ${t('status.fail')} (${errShort(st.error)})${st.skipped ? ' · ' + t('status.skipped') : ''}`; el.title = errText(st.error); needCheck.push(s); }
    else el.textContent = s.name;
    box.appendChild(el);
  }
  if (!state.running && needCheck.length) {
    const act = document.createElement('div');
    act.className = 'statusActions';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'link';
    b.textContent = t('status.openAll', { n: needCheck.length });
    b.addEventListener('click', () => needCheck.forEach(s => api.tabs.create({ url: storeSearchLink(s), active: false })));
    act.appendChild(b);
    box.appendChild(act);
  }
}

// ───────── 결과 ─────────
const fmtKRW = n => Number.isFinite(n) ? '₩' + Math.round(n).toLocaleString(numLocale()) : '-';
const errText = code => {
  if (!code) return '';
  if (/^HTTP /.test(code)) return code;
  const key = 'err.' + code;
  const txt = t(key);
  return txt === key ? t('err.unknown') : txt;
};
const errShort = code => {
  if (!code) return t('errShort.unknown');
  if (/^HTTP /.test(code)) return code;
  const key = 'errShort.' + code;
  const txt = t(key);
  return txt === key ? t('errShort.unknown') : txt;
};
const concText = c => (c === 'extrait' || c === 'parfum') ? t('conc.' + c) : c;
const SYMBOL = { USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$', KRW: '₩' };
const fmtOrig = (p, c) => `${SYMBOL[c] || (c + ' ')}${p.toFixed(c === 'KRW' || c === 'JPY' ? 0 : 2)}`;

function visibleItems() {
  const f = state.filters;
  const sizeSel = $('size').value;
  return state.results
    .filter(i => !i.nonFrag)
    .filter(i => f.loose || i.rel >= RELEVANCE_MIN)
    .filter(i => f[i.category] !== false)
    .filter(i => f.soldout || i.available)
    .filter(i => !sizeSel || String(i.size) === sizeSel)
    .map(i => {
      const krw = i.price * rate(i.currency);
      return { ...i, krw, perml: i.size ? krw / i.size : NaN };
    });
}

function renderSizeOptions(items) {
  const sel = $('size');
  const cur = sel.value;
  const sizes = [...new Set(items.map(i => i.size).filter(Boolean))].sort((a, b) => a - b);
  sel.innerHTML = `<option value="">${esc(t('size.all'))}</option>` + sizes.map(s => `<option value="${s}">${s}ml</option>`).join('');
  if (sizes.map(String).includes(cur)) sel.value = cur;
}

function renderResults() {
  const box = $('results');
  const tpl = $('cardTpl');
  // 용량 목록은 용량 필터를 제외한 결과 기준
  const sizeSel = $('size').value;
  $('size').value = '';
  renderSizeOptions(visibleItems());
  $('size').value = sizeSel;
  if ($('size').value !== sizeSel) $('size').value = '';

  let items = visibleItems();
  if (state.sort === 'perml') items.sort((a, b) => (isNaN(a.perml) ? Infinity : a.perml) - (isNaN(b.perml) ? Infinity : b.perml));
  else if (state.sort === 'store') items.sort((a, b) => a.storeName.localeCompare(b.storeName, 'ko') || a.krw - b.krw);
  else items.sort((a, b) => a.krw - b.krw);
  // 품절은 항상 뒤로
  items.sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0));

  // 최저가 카드
  const best = items.find(i => i.available && !i.partial && (i.category === 'boxed' || i.category === 'tester' || i.category === 'unboxed'))
    || items.find(i => i.available && !i.partial);
  const bestBox = $('best');
  if (best) {
    bestBox.hidden = false;
    bestBox.innerHTML = `<div class="lbl">${esc(t('best.label'))}${state.running ? esc(t('best.running')) : ''}</div>
      <div class="val">${fmtKRW(best.krw)}</div>
      <div class="det">${esc(best.storeName)} · ${esc(best.title)}${best.size ? ` · ${best.size}ml` : ''} · ${esc(t('catShort.' + best.category))} · ${fmtOrig(best.price, best.currency)} · <a href="${esc(best.url)}" target="_blank" rel="noopener">${esc(t('best.open'))}</a></div>`;
  } else bestBox.hidden = true;

  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const i of items.slice(0, 300)) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.href = i.url;
    if (!i.available) node.classList.add('soldout');
    const img = node.querySelector('.thumb');
    if (i.image) img.src = i.image; else img.classList.add('noimg');
    img.addEventListener('error', () => img.classList.add('noimg'));
    node.querySelector('.store').textContent = i.storeName;
    node.querySelector('.region').textContent = REGIONS[i.region]?.flag || '';
    node.querySelector('.title').textContent = i.vendor && !i.title.toLowerCase().includes(i.vendor.toLowerCase()) ? `${i.vendor} ${i.title}` : i.title;
    node.querySelector('.variant').textContent = i.variant || '';
    const badges = node.querySelector('.badges');
    const add = (t, c = '') => { const b = document.createElement('span'); b.className = 'badge ' + c; b.textContent = t; badges.appendChild(b); };
    if (i.partial) add(t('badge.partial'), 'partial');
    else add(t('catShort.' + i.category), i.category === 'tester' ? 'tester' : 'cat-' + i.category);
    if (i.size) add(`${i.size}ml`);
    if (i.conc) add(concText(i.conc));
    if (!i.available) add(t('badge.soldout'), 'out');
    if (i.rel < RELEVANCE_MIN) add(t('badge.lowrel'));
    node.querySelector('.krw').textContent = fmtKRW(i.krw);
    node.querySelector('.orig').textContent = fmtOrig(i.price, i.currency) + (i.priceMax ? ` ~ ${fmtOrig(i.priceMax, i.currency)}` : '');
    node.querySelector('.perml').textContent = Number.isFinite(i.perml) ? t('perml', { v: fmtKRW(i.perml) }) : '';
    frag.appendChild(node);
  }
  box.appendChild(frag);

  const empty = $('empty');
  if (!state.query) { empty.hidden = false; empty.textContent = t('empty.start'); }
  else if (!items.length && !state.running) {
    empty.hidden = false;
    empty.textContent = state.results.length ? t('empty.filtered') : t('empty.none');
  } else empty.hidden = true;
}

// ───────── 시작 ─────────
$('searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch($('q').value); });

function renderAll() {
  applyStatic();
  document.title = state.query ? `${state.query} · ${t('appName')}` : t('appName');
  renderChips();
  renderAdv();
  renderStores();
  renderRates();
  renderStatus();
  renderResults();
}

(async () => {
  await load();
  await initLang();
  applyStatic();
  document.title = t('appName');
  mountLangSwitch($('langSwitch'), renderAll);
  renderChips();
  renderAdv();
  renderStores();
  renderRates();
  renderResults();
  ensureRates();
  const q = new URLSearchParams(location.search).get('q');
  if (q) { $('q').value = q; runSearch(q); }
  else $('q').focus();
})();
