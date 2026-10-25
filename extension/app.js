import { DEFAULT_STORES, REGIONS, defaultSearchUrl, FREE_SHIPPING } from './stores.js';
import { searchStore, checkSiteAccess } from './adapters.js';
import { searchViaTab, tabsSupported, cleanupTabs, snapshotTabs } from './tabs.js';
import { CATEGORIES, classify, extractSize, extractConcentration, relevance, itemRelevance, splitRelevance, isNonFragrance, flankerWords, versionTags } from './classify.js';
import { parseSearch, brandVariants } from './ko-search.js';
import * as NF from './notify.js';
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
  dispCur: '',          // 표시 통화 (KRW·USD·GBP·EUR·CAD). 비어 있으면 언어·지역으로 정함
  opts: { tabs: true },
  route: {},           // storeId → { tabFails } 탭으로 읽기에 실패한 적 있는 사이트는 탭 순서를 뒤로 미룸
  rateOverride: {},
  rates: null,          // { at, src, values: {USD: 1400, ...} }
  results: [],          // 정규화된 결과
  storeStatus: {},      // storeId → { state, count, error }
  query: '',
  parts: { brand: '', name: '' },   // 검색한 브랜드·향수 이름 (영어)
  brandVars: [],        // 브랜드 다른 표기 (결과 확인용)
  conv: null,           // 검색어 변환 결과 (검색창 아래 안내)
  running: false,
};

// ───────── 저장소 ─────────
async function load() {
  try {
    const s = await api.storage.local.get(['enabled', 'custom', 'detected', 'urlOverride', 'filters', 'sort', 'opts', 'route', 'rateOverride', 'rates', 'dispCur']);
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
      dispCur: s.dispCur || '',
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
  if (cur === 'KRW') return 1;
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
  const tag = Object.keys(state.rateOverride).length ? t('rates.manual') : state.rates?.src === 'auto' ? t('rates.auto') : t('rates.default');
  // 표시 통화 기준으로 요약 (원화면 $1 ≈ ₩…, 파운드면 $1 ≈ £…, 달러면 £1 ≈ $…)
  const d = dispCur();
  const base = d === 'USD' ? 'GBP' : 'USD';
  $('rateInfo').textContent = `${SYMBOL[base]}1 ≈ ${fmtMoney(rate(base))} (${tag})`;
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
  $('dispCur').innerHTML = DISP_CURRENCIES.map(c => `<option value="${c}">${c} ${SYMBOL[c]}</option>`).join('');
  $('dispCur').value = dispCur();
}
$('optSoldout').addEventListener('change', e => { state.filters.soldout = e.target.checked; save('filters'); renderResults(); });
$('optLoose').addEventListener('change', e => { state.filters.loose = e.target.checked; save('filters'); renderResults(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; save('sort'); renderResults(); });
$('size').addEventListener('change', () => renderResults());
$('conc').addEventListener('change', () => renderResults());
$('dispCur').addEventListener('change', e => { state.dispCur = e.target.value; save('dispCur'); renderRates(); renderResults(); });

// 표시 통화: 직접 고른 값 → 없으면 언어·지역 (한국어 ₩, 영국 £, 캐나다 C$, 유럽 €, 그 외 $)
const DISP_CURRENCIES = ['KRW', 'USD', 'GBP', 'EUR', 'CAD'];
function dispCur() {
  if (DISP_CURRENCIES.includes(state.dispCur)) return state.dispCur;
  const l = (navigator.language || '').toLowerCase();
  if (getLang() === 'ko' || l.startsWith('ko')) return 'KRW';
  if (/-gb$|^en-ie|-uk$/.test(l)) return 'GBP';
  if (/-ca$/.test(l)) return 'CAD';
  if (/^(de|fr|it|es|nl|pt|fi|el|sk|sl|et|lv|lt)\b/.test(l)) return 'EUR';
  return 'USD';
}

function renderAdv() {
  $('optTabs').checked = !!state.opts.tabs && tabsSupported();
  $('optTabs').disabled = !tabsSupported();
}
$('optTabs').addEventListener('change', e => { state.opts.tabs = e.target.checked; save('opts'); });

// ───────── 검색 ─────────
// 관련도: 브랜드를 알면 브랜드·향수 이름을 따로 확인, 모르면 검색어 전체로 확인
function itemRel(raw, query) {
  const core = [raw.title, raw.vendor], extra = [raw.variant, raw.relHint || ''];
  const p = state.parts;
  if (p && p.brand) return splitRelevance(p.name, state.brandVars, core, extra);
  return itemRelevance(query, core, extra);
}

function normalizeItem(raw, store, query) {
  const size = extractSize(raw.variant, raw.title);
  const category = classify(raw, size);
  return {
    ...raw,
    storeId: store.id, storeName: store.name, region: store.region,
    size, category,
    conc: extractConcentration(`${raw.title} ${raw.variant} ${raw.type}`),
    nonFrag: isNonFragrance(raw),
    ...versionAndFlanker(raw, query),
  };
}

// 검색어에 없는 다른 버전(Elixir, Black Iris, Exclusif 등)은 관련도를 낮춰 "숨긴 결과"로 보냄
function versionAndFlanker(raw, query) {
  let rel = itemRel(raw, query);
  const flanker = flankerWords(query, raw.title, [...(state.brandVars || []), raw.vendor || '']);
  if (flanker.length && rel >= RELEVANCE_MIN) rel = Math.min(rel, 0.6);
  return { rel, flanker, ver: versionTags(raw.title, raw.variant) };
}

// 탭으로 읽기에 실패한 적 있는 사이트도 건너뛰지 않고 매번 다시 시도함.
// 다만 다른 사이트를 먼저 끝내도록 탭 순서만 뒤로 미룸
const hadTabFail = id => { const r = state.route[id]; return !!(r && r.tabFails > 0); };
function noteTab(id, ok) {
  if (ok) { if (state.route[id]) { delete state.route[id]; save('route'); } return; }
  const r = state.route[id] || { tabFails: 0 };
  state.route[id] = { tabFails: (r.tabFails || 0) + 1 };
  save('route');
}

// 검색창 아래 안내: 기능 안내 / 실제로 검색한 브랜드·이름
function renderQueryNote() {
  const el = $('qNote');
  const c = state.conv;
  el.className = 'qNote';
  if (!c || (!c.changed && !c.brandAuto)) { el.textContent = t('qnote.hint'); return; }
  if (!c.query) { el.textContent = t('qnote.none'); el.classList.add('warn'); return; }
  const shown = [c.brand, c.name].filter(Boolean).join(' · ');
  const parts = [];
  if (c.changed) parts.push(t('qnote.conv', { q: shown }));
  else parts.push(t('qnote.split', { q: shown }));
  if (c.brandAuto) parts.push(t('qnote.brandAuto', { b: c.brand }));
  if (c.unknown.length) parts.push(t('qnote.unknown', { w: c.unknown.join(', ') }));
  el.textContent = parts.join(' · ');
  el.classList.add(c.unknown.length ? 'warn' : 'conv');
}

const formInput = () => [$('qBrand').value, $('qName').value];

async function runSearch(brandInput, nameInput) {
  brandInput = String(brandInput || '').trim();
  nameInput = String(nameInput || '').trim();
  if ((!brandInput && !nameInput) || state.running) return;
  // 한글 브랜드·향수 이름은 영어로 바꿔서 검색 (해외 쇼핑몰은 영어 이름으로만 찾을 수 있음)
  // 브랜드 칸이 비어 있으면 이름 칸에서 브랜드를 찾아봄
  state.conv = parseSearch(brandInput, nameInput);
  renderQueryNote();
  const query = state.conv.query;
  if (!query) return;
  state.parts = { brand: state.conv.brand, name: state.conv.name };
  state.brandVars = brandVariants(state.conv.brand);
  state.running = true;
  state.stopped = false;
  state.abort = { aborted: false };
  state.query = query;
  state.results = [];
  state.storeStatus = {};
  state.startedAt = Date.now();
  state.finishedAt = 0;
  $('size').value = '';
  const qs = new URLSearchParams();
  if (brandInput) qs.set('b', brandInput);
  if (nameInput) qs.set('n', nameInput);
  history.replaceState(null, '', `?${qs}`);
  document.title = `${query} · ${t('appName')}`;
  rememberRecent(brandInput, nameInput);

  const stores = allStores().filter(isOn);
  stores.forEach(s => { state.storeStatus[s.id] = { state: 'wait' }; });
  startProgressTimer();
  renderStatus();
  renderResults();

  await ensureRates();

  // Safari 가 사이트 접근을 막고 있으면(확장 업데이트·재설치 후 자주 초기화됨) 모든 요청이 실패하고 탭도 사이트마다 허락을 기다리며 멈춤.
  // 30곳을 헛돌지 말고 바로 알려줌
  const access = await checkSiteAccess();
  renderAccess(access === 'blocked');
  if (access === 'blocked') {
    // 권한이 없을 때 쌓인 "탭 실패" 기록은 사이트 문제가 아니라서 지움
    state.route = {}; save('route');
    stores.forEach(s => { state.storeStatus[s.id] = { state: 'err', error: 'noAccess' }; });
    state.running = false;
    state.finishedAt = Date.now();
    stopProgressTimer();
    renderStatus();
    renderResults();
    return;
  }

  const signal = state.abort;
  const useTabs = state.opts.tabs && tabsSupported();
  if (useTabs) await snapshotTabs();
  const tabJobs = [];
  const deferredTabs = [];   // 예전에 탭 읽기가 실패했던 사이트 → 나머지가 끝난 뒤 시도
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
      // 첫 요청이 왜 실패했는지 칩에 남겨둠 (마우스를 올리면 보임)
      if (fetchRes) state.storeStatus[store.id].fetchError = fetchRes.mode === 'link' ? 'nodata' : (fetchRes.error || 'unknown');
      renderStatus();
    }));
  };

  let idx = 0;
  const worker = async () => {
    while (idx < stores.length) {
      const store = stores[idx++];
      if (signal.aborted) { apply(store, { items: [], mode: 'error', error: 'stopped' }); continue; }
      const canTab = useTabs;
      const toTab = (fetchRes) => {
        if (hadTabFail(store.id)) { state.storeStatus[store.id] = { state: 'tabWait' }; renderStatus(); deferredTabs.push([store, fetchRes]); }
        else queueTab(store, fetchRes);
      };
      if (store.tabOnly && canTab) { toTab(null); continue; }
      let res = await searchStore(store, query, {
        detected: state.detected[store.id],
        searchUrlOverride: state.urlOverride[store.id],
        regionCurrency: REGION_CURRENCY[store.region] || 'USD',
      });
      if (res.detected && state.detected[store.id] !== res.detected) { state.detected[store.id] = res.detected; save('detected'); }
      if (res.resetDetected) { delete state.detected[store.id]; save('detected'); }
      // 브랜드+이름으로 아무것도 안 나오면 이름만으로 한 번 더 (쇼핑몰마다 브랜드 표기가 달라서: Roja / Roja Dove, MFK 등)
      // 결과의 브랜드 확인은 그대로 하므로 다른 브랜드의 같은 이름은 걸러짐
      const p = state.parts;
      if (p.brand && p.name && !signal.aborted && res.items.length === 0 &&
          res.mode !== 'error' && res.mode !== 'link' && /[a-z]{4,}/i.test(p.name)) {
        const res2 = await searchStore(store, p.name, {
          detected: state.detected[store.id],
          searchUrlOverride: state.urlOverride[store.id],
          regionCurrency: REGION_CURRENCY[store.region] || 'USD',
        });
        if (res2.items.length) res = { ...res, items: res2.items, mode: res2.mode };
      }
      const failed = res.mode === 'error' || res.mode === 'link';
      if (failed && canTab && !signal.aborted) toTab(res);
      else apply(store, res);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stores.length) }, worker));
  for (const [store, fetchRes] of deferredTabs) queueTab(store, fetchRes);
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

// ───────── 사이트 접근 권한 안내 ─────────
function renderAccess(blocked) {
  const box = $('access');
  box.hidden = !blocked;
  if (!blocked) return;
  box.innerHTML = `
    <div class="accTitle">${esc(t('access.title'))}</div>
    <ol class="accSteps"><li>${esc(t('access.step1'))}</li><li>${esc(t('access.step2'))}</li><li>${esc(t('access.step3'))}</li></ol>
    <div class="accBtns">
      <button type="button" id="accRequest">${esc(t('access.request'))}</button>
      <button type="button" id="accRetry" class="ghost">${esc(t('access.retry'))}</button>
    </div>`;
  $('accRequest').addEventListener('click', async () => {
    try { await api.permissions.request({ origins: ['<all_urls>'] }); } catch { /* 지원 안 하면 설정에서 직접 */ }
    runSearch(...formInput());
  });
  $('accRetry').addEventListener('click', () => runSearch(...formInput()));
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

// 최근 검색어: { b: 브랜드 칸, n: 이름 칸 } (예전 버전의 문자열도 그대로 읽음)
async function rememberRecent(b, n) {
  try {
    const { recent = [] } = await api.storage.local.get('recent');
    const key = r => (typeof r === 'string' ? `\u0001${r}` : `${r.b || ''}\u0001${r.n || ''}`).toLowerCase();
    const cur = { b, n };
    const next = [cur, ...recent.filter(r => key(r) !== key(cur))].slice(0, 10);
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
  const wrap = $('statusBox');
  const entries = Object.entries(state.storeStatus);
  if (!entries.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  box.innerHTML = '';
  // 접힌 줄: 사이트별 결과 요약 (직접 확인할 곳이 있으면 강조)
  {
    const all = entries.length;
    const okN = entries.filter(([, e]) => e.state === 'ok').length;
    const chkN = entries.filter(([, e]) => ['link', 'blocked', 'err', 'stopped'].includes(e.state)).length;
    const sum = $('statusSum');
    sum.innerHTML = `<span class="sumMain">${esc(t('status.sum', { all, ok: okN }))}</span>` +
      (chkN && !state.running ? `<span class="sumCheck">${esc(t('status.sumCheck', { n: chkN }))}</span>` : '');
  }
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
    const fetchNote = st.fetchError ? t('status.fetchNote', { why: errShort(st.fetchError) }) : '';
    if (st.state === 'ok') { el.textContent = `${s.name} ${st.count}${st.viaTab ? ' · ' + t('status.viaTab') : ''}`; el.title = fetchNote; }
    else if (st.state === 'tab') el.textContent = `${s.name} · ${t('status.tab')}`;
    else if (st.state === 'tabWait') el.textContent = `${s.name} · ${t('status.tabWait')}`;
    else if (st.state === 'stopped') { el.textContent = `${s.name} · ${t('status.stopped')}`; needCheck.push(s); }
    else if (st.state === 'blocked') { el.textContent = `${s.name} · ${t('status.blocked')}${st.skipped ? ' · ' + t('status.skipped') : ''}`; el.title = errText('blocked'); needCheck.push(s); }
    else if (st.state === 'none') { el.textContent = `${s.name} 0${st.viaTab ? ' · ' + t('status.viaTab') : ''}`; el.title = fetchNote; }
    else if (st.state === 'link') { el.textContent = `${s.name} · ${t('status.check')}${st.skipped ? ' · ' + t('status.skipped') : ''}`; el.className = 'st link'; needCheck.push(s); }
    else if (st.state === 'err') { el.textContent = `${s.name} · ${t('status.fail')} (${errShort(st.error)})${st.skipped ? ' · ' + t('status.skipped') : ''}`; el.title = [errText(st.error), fetchNote].filter(Boolean).join('\n'); needCheck.push(s); }
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
// 금액 표시: 내부는 원화 기준(krw)으로 계산하고, 화면에는 고른 통화로
function fmtMoney(krw) {
  if (!Number.isFinite(krw)) return '-';
  const c = dispCur();
  const v = krw / rate(c);
  if (!Number.isFinite(v)) return '-';
  if (c === 'KRW') return '₩' + Math.round(v).toLocaleString(numLocale());
  return SYMBOL[c] + v.toLocaleString(numLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const fmtKRW = fmtMoney;
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
    .filter(i => f.loose || (!i.nonFrag && i.rel >= RELEVANCE_MIN))
    .filter(i => f[i.category] !== false)
    .filter(i => f.soldout || i.available)
    .filter(i => !sizeSel || String(i.size) === sizeSel)
    .filter(i => !$('conc').value || (i.conc || '?') === $('conc').value)
    .map(i => {
      const krw = i.price * rate(i.currency);
      return { ...i, krw, perml: i.size ? krw / i.size : NaN };
    });
}

function renderConcOptions(items) {
  const sel = $('conc');
  const cur = sel.value;
  const order = ['extrait', 'parfum', 'EDP', 'EDT', 'EDC', '?'];
  const have = [...new Set(items.map(i => i.conc || '?'))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  sel.innerHTML = `<option value="">${esc(t('conc.all'))}</option>` + have.map(c => `<option value="${esc(c)}">${esc(c === '?' ? t('conc.unknown') : concText(c))}</option>`).join('');
  if (have.includes(cur)) sel.value = cur;
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
  const sizeSel = $('size').value, concSel = $('conc').value;
  $('size').value = ''; $('conc').value = '';
  renderSizeOptions(visibleItems());
  renderConcOptions(visibleItems());
  $('size').value = sizeSel; $('conc').value = concSel;
  if ($('size').value !== sizeSel) $('size').value = '';
  if ($('conc').value !== concSel) $('conc').value = '';

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
    // 향수병 라벨처럼: 가장 낮은 가격을 가운데 크게
    const bestTitle = best.vendor && !best.title.toLowerCase().includes(best.vendor.toLowerCase()) ? `${best.vendor} ${best.title}` : best.title;
    const tags = [best.size ? `${best.size}ml` : '', t('catShort.' + best.category), best.conc ? concText(best.conc) : ''].filter(Boolean);
    bestBox.innerHTML = `<div class="label">
      <div class="lbl">${esc(t('best.label'))}${state.running ? esc(t('best.running')) : ''}</div>
      <div class="val">${fmtKRW(best.krw)}</div>
      <div class="orig">${esc(fmtOrig(best.price, best.currency))}</div>
      <div class="rule" aria-hidden="true"></div>
      <div class="ttl">${esc(bestTitle)}</div>
      <div class="tags">${tags.map(x => `<span>${esc(x)}</span>`).join('')}</div>
      <a class="go" href="${esc(best.url)}" target="_blank" rel="noopener">${esc(t('best.go', { store: best.storeName }))}</a>
    </div>`;
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
    const fs = FREE_SHIPPING[i.storeId];
    if (fs) {
      const [min, cur] = fs;
      const ship = document.createElement('span');
      const free = i.currency === cur && i.price >= min;
      ship.className = 'ship' + (free ? ' free' : '');
      ship.textContent = free ? t('ship.free') : t('ship.over', { v: fmtOrig(min, cur) });
      node.querySelector('.meta').appendChild(ship);
    }
    node.querySelector('.title').textContent = i.vendor && !i.title.toLowerCase().includes(i.vendor.toLowerCase()) ? `${i.vendor} ${i.title}` : i.title;
    node.querySelector('.variant').textContent = i.variant || '';
    const badges = node.querySelector('.badges');
    const add = (t, c = '') => { const b = document.createElement('span'); b.className = 'badge ' + c; b.textContent = t; badges.appendChild(b); };
    if (i.partial) add(t('badge.partial'), 'partial');
    else add(t('catShort.' + i.category), i.category === 'tester' ? 'tester' : 'cat-' + i.category);
    if (i.size) add(`${i.size}ml`);
    if (i.conc) add(concText(i.conc));
    if (!i.available) add(t('badge.soldout'), 'out');
    for (const v of i.ver || []) add(t('ver.' + v), 'ver');
    if (i.nonFrag) add(t('badge.nonfrag'), 'nonfrag');
    else if (i.flanker && i.flanker.length) add(t('badge.flanker', { w: i.flanker.map(w => w[0].toUpperCase() + w.slice(1)).join(' ') }), 'flanker');
    else if (i.rel < RELEVANCE_MIN) add(t('badge.lowrel'));
    // 품절 상품: 재입고 알림 버튼 (이미 등록한 상품은 재고가 있어도 표시)
    const w = NF.watchFor(i.url);
    if (!i.available || w) {
      const bell = document.createElement('button');
      bell.type = 'button';
      const pend = NF.notify.pending.has(String(i.url).split('#')[0]);
      bell.className = 'bell' + (w ? ' on' : '');
      bell.textContent = pend ? t('bell.wait') : w ? t('bell.on') : NF.isSiteOnly(i.storeId) ? t('bell.site') : t('bell.add');
      bell.disabled = pend;
      bell.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onBell(i, w); });
      node.querySelector('.body').appendChild(bell);
    }
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

  // 숨긴 결과 (관련 없는 상품·향수 아닌 품목) 개수와 보기/숨기기
  const note = $('hiddenNote');
  const hidden = state.results.filter(i => i.nonFrag || i.rel < RELEVANCE_MIN).length;
  if (!state.query || !hidden) note.hidden = true;
  else {
    note.hidden = false;
    note.textContent = state.filters.loose ? t('hidden.shown', { n: hidden }) : t('hidden.count', { n: hidden });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = state.filters.loose ? t('hidden.hide') : t('hidden.show');
    btn.addEventListener('click', () => {
      state.filters.loose = !state.filters.loose;
      $('optLoose').checked = state.filters.loose;
      save('filters');
      renderResults();
    });
    note.appendChild(btn);
  }
}

// ───────── 시작 ─────────
$('searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(...formInput()); });

// 상품·사이트 링크는 항상 새 탭으로 (Safari 확장 화면에서는 target="_blank" 가 무시돼 검색 화면이 바뀌는 경우가 있음)
// 클릭: 새 탭으로 바로 이동 / ⌘ 클릭·가운데 클릭: 검색 화면에 머문 채 뒤에 열기
let selfTab = null;
(async () => { try { selfTab = await api.tabs.getCurrent(); } catch { /* 무시 */ } })();
function openInNewTab(url, background) {
  const opts = { url, active: !background };
  if (selfTab && selfTab.index != null) opts.index = selfTab.index + 1;
  if (selfTab && selfTab.windowId != null) opts.windowId = selfTab.windowId;
  return api.tabs.create(opts).catch(() => api.tabs.create({ url, active: !background }))
    .catch(() => { window.open(url, '_blank', 'noopener'); });
}
const linkHandler = e => {
  if (e.target.closest && e.target.closest('.bell')) return;
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || !/^https?:/i.test(a.href)) return;
  if (e.type === 'click' && e.button !== 0) return;
  if (e.type === 'auxclick' && e.button !== 1) return;
  e.preventDefault();
  openInNewTab(a.href, e.metaKey || e.ctrlKey || e.button === 1);
};
document.addEventListener('click', linkHandler);
document.addEventListener('auxclick', linkHandler);

// ───────── 재입고 알림 (개발판) ─────────
let toastTimer = 0;
function toast(msg, kind = '', ms = 6000) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// 서버가 확인할 수 없는 사이트: 상품 페이지를 열고 사이트 자체의 재입고 알림 신청을 안내
function openSiteAlert(item) {
  openInNewTab(item.url, false);
  toast(t('nf.site.how', { store: item.storeName }), 'warn', 12000);
}

function openNotifyPanel() {
  openSettings();
  const p = $('notifyPanel');
  p.open = true;
  setTimeout(() => p.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

// ───────── 설정 시트 (사이트·환율·고급·재입고 알림) ─────────
let sheetReturn = null;
function openSettings() {
  const sh = $('settings');
  if (!sh.hidden) return;
  sheetReturn = document.activeElement;
  sh.hidden = false; $('sheetScrim').hidden = false;
  document.documentElement.classList.add('sheetOpen');
  $('openSettings').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => { sh.classList.add('in'); $('sheetScrim').classList.add('in'); $('closeSettings').focus({ preventScroll: true }); });
}
function closeSettings() {
  const sh = $('settings');
  if (sh.hidden) return;
  sh.classList.remove('in'); $('sheetScrim').classList.remove('in');
  document.documentElement.classList.remove('sheetOpen');
  $('openSettings').setAttribute('aria-expanded', 'false');
  const done = () => { sh.hidden = true; $('sheetScrim').hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 220);
  if (sheetReturn && sheetReturn.focus) sheetReturn.focus({ preventScroll: true });
}
// 스크롤하면 머리 아래에 선을 그어 내용과 구분
addEventListener('scroll', () => document.querySelector('.top').classList.toggle('scrolled', scrollY > 4), { passive: true });
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);
$('sheetScrim').addEventListener('click', closeSettings);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('settings').hidden) closeSettings(); });

async function onBell(item, w) {
  if (!w && NF.isSiteOnly(item.storeId)) { openSiteAlert(item); return; }
  if (!NF.configured()) { toast(t('nf.err.notSet'), 'warn'); return; }
  try {
    if (w) {
      await NF.removeWatch(w.id);
      toast(t('nf.removed'));
      return;
    }
    if (!NF.notify.me) await NF.refresh();
    if (!NF.hasChannel()) { openNotifyPanel(); toast(t('nf.needChannel'), 'warn'); return; }
    const res = await NF.addWatch(item, rate(item.currency) / rate(dispCur()), dispCur());
    if (res.duplicate) toast(t('nf.dup'));
    else toast(t('nf.added', { where: sentWhere(res.sent) }), 'ok');
  } catch (e) {
    if (e.code === 'inStock') toast(t('nf.err.inStock', { p: e.data && e.data.price ? ` (${fmtOrig(e.data.price, item.currency)})` : '' }), 'warn');
    else if (e.code === 'noChannel') { openNotifyPanel(); toast(t('nf.needChannel'), 'warn'); }
    else if (e.code === 'blocked' || e.code === 'unsupported') {
      // 이 사이트는 서버로 재고 확인 불가 → 다음부터 버튼을 "사이트 알림 신청"으로 바꾸고, 지금 바로 안내
      await NF.markSiteOnly(item.storeId);
      renderResults();
      openSiteAlert(item);
    }
    else toast(NF.errText(e.code, e.data), 'warn');
  }
}
// 확인 메시지를 보낸 곳 ("텔레그램·이메일")
const sentWhere = sent => [sent.telegram === 'ok' ? t('nf.tg.title') : '', sent.email === 'ok' ? t('nf.mail.title') : ''].filter(Boolean).join('·') || '—';

// 버튼 하나 만들기
function btn(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); } catch (e) { toast(NF.errText(e.code, e.data), 'warn'); } finally { b.disabled = false; }
  });
  return b;
}
function line(text, cls = 'nfLine') { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; }

function renderNotify() {
  const N = NF.notify, me = N.me;
  const n = N.alerts.length;
  $('notifyInfo').textContent = !NF.configured() ? t('nf.off') : N.error ? t('nf.errShort')
    : !me ? '' : !NF.hasChannel() ? t('nf.noChannelShort') : t('nf.count', { n });

  // 텔레그램
  const tg = $('nfTg'); tg.innerHTML = '';
  if (!NF.configured()) tg.append(line(t('nf.err.notSet'), 'nfLine muted'));
  else if (me && !me.telegramAvailable) tg.append(line(t('nf.tg.unavailable'), 'nfLine muted'));
  else if (me && me.telegram) {
    tg.append(line(t('nf.tg.linked', { name: me.telegram.name || '' }), 'nfLine good'));
    tg.append(btn(t('nf.tg.unlink'), async () => { await NF.telegramUnlink(); toast(t('nf.tg.unlinked')); }, 'ghost'));
  } else if (N.tgWaiting) {
    tg.append(line(t('nf.tg.waiting'), 'nfLine'));
    tg.append(btn(t('nf.tg.reopen'), async () => openInNewTab(N.tgUrl, false), 'ghost'));
    tg.append(btn(t('nf.cancel'), async () => NF.telegramCancel(), 'ghost'));
  } else {
    tg.append(line(t('nf.tg.how'), 'nfLine muted'));
    tg.append(btn(t('nf.tg.link'), async () => { const url = await NF.telegramStart(); openInNewTab(url, false); }));
  }

  // 이메일
  const mail = $('nfMail'); mail.innerHTML = '';
  if (!NF.configured()) mail.append(line(t('nf.err.notSet'), 'nfLine muted'));
  else if (me && !me.emailAvailable) mail.append(line(t('nf.mail.unavailable'), 'nfLine muted'));
  else if (me && me.email) {
    mail.append(line(t('nf.mail.on', { email: me.email }), 'nfLine good'));
    mail.append(btn(t('nf.mail.remove'), async () => { await NF.emailRemove(); toast(t('nf.mail.removed')); }, 'ghost'));
  } else {
    if (me && me.emailPending) {
      mail.append(line(t('nf.mail.pending', { email: me.emailPending }), 'nfLine'));
      mail.append(btn(t('nf.mail.resend'), async () => { await NF.emailSubmit(me.emailPending); toast(t('nf.mail.sent', { email: me.emailPending }), 'ok'); }, 'ghost'));
      mail.append(btn(t('nf.mail.checkNow'), async () => { await NF.refresh(); }, 'ghost'));
      mail.append(btn(t('nf.cancel'), async () => NF.emailRemove(), 'ghost'));
      return finishNotify();
    }
    const row = document.createElement('form');
    row.className = 'nfRow';
    const input = document.createElement('input');
    input.type = 'email'; input.placeholder = t('nf.mail.ph'); input.autocomplete = 'email'; input.required = true;
    input.setAttribute('autocapitalize', 'off');
    const go = document.createElement('button');
    go.type = 'submit'; go.textContent = t('nf.mail.send');
    row.append(input, go);
    row.addEventListener('submit', async e => {
      e.preventDefault();
      go.disabled = true;
      try { await NF.emailSubmit(input.value); toast(t('nf.mail.sent', { email: input.value.trim() }), 'ok'); }
      catch (er) { toast(NF.errText(er.code, er.data), 'warn'); }
      finally { go.disabled = false; }
    });
    mail.append(row);
    if (me && me.emailLimited) mail.append(line(t('nf.mail.limited'), 'nfLine muted small'));
  }
  finishNotify();
}

// 테스트 버튼·상태·알림 목록·고급
function finishNotify() {
  const N = NF.notify, me = N.me, n = N.alerts.length;

  $('nfTest').disabled = !NF.hasChannel();
  const st = $('nfStatus');
  st.className = 'nfStatus' + (N.error ? ' warn' : '');
  st.textContent = N.error ? NF.errText(N.error) : (NF.configured() && me && N.lastRun ? t('nf.lastRun', { when: NF.ago(N.lastRun.at) }) : '');

  // 알림 목록
  const box = $('nfList'); box.innerHTML = '';
  if (!n) box.append(line(t('nf.empty'), 'hint'));
  for (const w of N.alerts) {
    const row = document.createElement('div');
    row.className = 'nfItem' + (w.inStock ? ' in' : '') + (w.lastError ? ' err' : '');
    const name = [w.vendor && !w.title.toLowerCase().includes(w.vendor.toLowerCase()) ? w.vendor : '', w.title].filter(Boolean).join(' ');
    const opt = [w.variant, w.size && !String(w.variant).includes(String(w.size)) ? `${w.size}ml` : '', w.category ? t('catShort.' + w.category) : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<div class="nfMain"><div class="nfName"><b>${esc(w.storeName)}</b> · <a href="${esc(w.url)}">${esc(name)}</a></div>
      <div class="nfMeta">${esc(opt)}${opt ? ' · ' : ''}${esc(NF.watchStateText(w))}${NF.checkedText(w) ? ' · ' + esc(NF.checkedText(w)) : ''}</div></div>`;
    const del = btn(N.pending.has(w.url) ? t('bell.wait') : t('nf.remove'), async () => { await NF.removeWatch(w.id); toast(t('nf.removed')); }, 'ghost');
    del.disabled = N.pending.has(w.url);
    row.appendChild(del);
    box.appendChild(row);
  }

  // 고급
  $('nfCode').value = NF.deviceCode() || '';
  if (document.activeElement !== $('nfServer')) $('nfServer').value = NF.serverUrl();
}

NF.notify.onChange = () => { renderNotify(); renderResults(); };
$('nfTest').addEventListener('click', async () => {
  try {
    const r = await NF.sendTest();
    toast(t('nf.testSent', { tg: NF.sentText(r.sent.telegram), mail: NF.sentText(r.sent.email) }), 'ok');
  } catch (e) { toast(NF.errText(e.code, e.data), 'warn'); }
});
$('nfCodeCopy').addEventListener('click', async () => {
  const c = NF.deviceCode();
  if (!c) return;
  try { await navigator.clipboard.writeText(c); toast(t('nf.adv.copied'), 'ok'); } catch { $('nfCode').select(); }
});
$('nfCodeUse').addEventListener('click', async () => {
  try { await NF.useDeviceCode($('nfCodeIn').value); $('nfCodeIn').value = ''; toast(t('nf.adv.used'), 'ok'); }
  catch (e) { toast(NF.errText(e.code, e.data), 'warn'); }
});
$('nfServerSave').addEventListener('click', async () => { await NF.setServer($('nfServer').value); toast(NF.notify.error ? NF.errText(NF.notify.error) : t('nf.adv.saved'), NF.notify.error ? 'warn' : 'ok'); });
$('nfDelete').addEventListener('click', async () => {
  const b = $('nfDelete');
  // 두 번 눌러야 삭제 (실수 방지)
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = t('nf.adv.deleteConfirm'); setTimeout(() => { delete b.dataset.armed; b.textContent = t('nf.adv.delete'); }, 5000); return; }
  delete b.dataset.armed; b.textContent = t('nf.adv.delete');
  try { await NF.deleteMe(); toast(t('nf.adv.deleted'), 'ok'); } catch (e) { toast(NF.errText(e.code, e.data), 'warn'); }
});
$('notifyPanel').addEventListener('toggle', () => { if ($('notifyPanel').open && NF.configured()) NF.refresh(); });
// 메일 앱이나 텔레그램에서 돌아오면 연결 상태 새로 확인
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && NF.configured() && ($('notifyPanel').open || NF.notify.tgWaiting || (NF.notify.me && NF.notify.me.emailPending))) NF.refresh();
});

function renderAll() {
  applyStatic();
  renderQueryNote();
  renderNotify();
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
  await NF.loadConf();
  await initLang();
  applyStatic();
  document.title = t('appName');
  mountLangSwitch($('langSwitch'), renderAll);
  renderChips();
  renderAdv();
  renderStores();
  renderRates();
  renderQueryNote();
  renderNotify();
  renderResults();
  ensureRates();
  // 이미 알림을 쓰는 기기만 상태를 받아옴 (안 쓰는 사람은 서버에 가입되지 않게)
  if (NF.configured() && NF.notify.conf.key) NF.refresh();
  // ?b=브랜드&n=이름 (예전 주소 ?q=검색어 도 지원 → 이름 칸에 넣고 브랜드는 자동 인식)
  const sp = new URLSearchParams(location.search);
  const b = sp.get('b') || '', n = sp.get('n') || sp.get('q') || '';
  if (b || n) { $('qBrand').value = b; $('qName').value = n; runSearch(b, n); }
  else $('qBrand').focus();
})();
