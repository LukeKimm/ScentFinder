// 재입고 알림 — 알림 서버(Cloudflare Workers)와 통신
// 사용자는 확장 화면에서만 등록: 기기별 자동 가입 → 텔레그램 연결 / 이메일 인증 → 품절 상품에 🔔
// 서버 코드와 운영자 설치 방법: server/README.md
import { t, getLang } from './i18n.js';
import { ALERT_SERVER } from './alerts-config.js';

const api = globalThis.browser ?? globalThis.chrome;
const TIMEOUT = 25000;

export const notify = {
  conf: { server: '', userId: '', key: '' },   // server: 직접 바꾼 서버 주소(고급). 비어 있으면 기본 주소
  me: null,             // { telegram, email, emailPending, telegramAvailable, emailAvailable, emailLimited }
  alerts: [],           // 내 알림 목록
  lastRun: null,        // 서버의 마지막 확인 기록
  error: '',            // 마지막 연결 오류 코드
  pending: new Set(),   // 처리 중인 상품 주소
  tgWaiting: 0,         // 텔레그램 연결 대기 시작 시각
  tgUrl: '',
  onChange: () => {},
};

const cleanUrl = u => String(u || '').split('#')[0];
export const serverUrl = () => (notify.conf.server || ALERT_SERVER || '').replace(/\/+$/, '');
export const configured = () => !!serverUrl();
export const hasChannel = () => !!(notify.me && (notify.me.telegram || notify.me.email));
export const watchFor = url => notify.alerts.find(w => w.url === cleanUrl(url));
const changed = () => { try { notify.onChange(); } catch { /* 화면 갱신 오류는 무시 */ } };
const err = (code, data) => Object.assign(new Error(code), { code, data });

async function saveConf() {
  try { await api.storage.local.set({ notify: notify.conf }); } catch { /* 무시 */ }
}
export async function loadConf() {
  try {
    const { notify: c, nfSiteOnly } = await api.storage.local.get(['notify', 'nfSiteOnly']);
    if (c) notify.conf = { server: c.server || '', userId: c.userId || '', key: c.key || '' };
    if (nfSiteOnly) siteOnly = nfSiteOnly;
  } catch { /* 무시 */ }
}

// 서버에서 재고를 확인할 수 없는 사이트 (봇 차단 등) → 🔔 를 누르면 사이트 자체의 재입고 알림으로 안내
// 사이트 사정이 바뀔 수 있어서 7일 뒤에는 다시 서버 확인을 시도
const SITE_ONLY_DAYS = 7;
let siteOnly = {};   // storeId → 기록 시각
export const isSiteOnly = storeId => !!(siteOnly[storeId] && Date.now() - siteOnly[storeId] < SITE_ONLY_DAYS * 864e5);
export async function markSiteOnly(storeId) {
  if (!storeId) return;
  siteOnly[storeId] = Date.now();
  try { await api.storage.local.set({ nfSiteOnly: siteOnly }); } catch { /* 무시 */ }
}

async function rawCall(method, path, body, key) {
  if (!configured()) throw err('notSet');
  let r;
  try {
    r = await fetch(serverUrl() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT) : undefined,
    });
  } catch { throw err('server'); }
  let data = null;
  try { data = await r.json(); } catch { /* 서버가 아닌 주소 */ }
  if (!data) throw err('server');
  if (!data.ok) throw err(data.error || 'server', data);
  return data;
}

// 처음 쓸 때 기기별로 자동 가입 (사용자가 입력할 것 없음)
async function ensureUser() {
  if (notify.conf.key) return;
  const r = await rawCall('POST', '/api/register', { lang: getLang() });
  notify.conf.userId = r.userId;
  notify.conf.key = r.key;
  await saveConf();
}

async function call(method, path, body) {
  await ensureUser();
  try {
    return await rawCall(method, path, body, notify.conf.key);
  } catch (e) {
    // 서버에서 내 정보가 지워졌으면(또는 서버를 바꿨으면) 새로 가입해서 한 번 더
    if (e.code !== 'auth') throw e;
    notify.conf.key = ''; notify.conf.userId = '';
    await ensureUser();
    return rawCall(method, path, body, notify.conf.key);
  }
}

export async function refresh() {
  if (!configured()) { notify.me = null; notify.alerts = []; notify.error = ''; changed(); return; }
  try {
    const r = await call('GET', '/api/me');
    notify.me = r.me;
    notify.alerts = r.alerts || [];
    notify.lastRun = r.lastRun;
    notify.error = '';
    if (notify.me.telegram) notify.tgWaiting = 0;
  } catch (e) {
    notify.error = e.code || 'server';
  }
  changed();
}

// ───────── 텔레그램 ─────────
// 연결 링크(t.me/봇?start=코드)를 받아 열고, 사용자가 텔레그램에서 "시작"을 누를 때까지 상태를 확인
let tgTimer = 0;
export async function telegramStart() {
  const r = await call('POST', '/api/telegram/start');
  notify.tgUrl = r.url;
  notify.tgWaiting = Date.now();
  changed();
  clearInterval(tgTimer);
  tgTimer = setInterval(async () => {
    if (!notify.tgWaiting || Date.now() - notify.tgWaiting > 15 * 60 * 1000) { clearInterval(tgTimer); notify.tgWaiting = 0; changed(); return; }
    await refresh();
    if (notify.me && notify.me.telegram) clearInterval(tgTimer);
  }, 2500);
  return r.url;
}
export function telegramCancel() { clearInterval(tgTimer); notify.tgWaiting = 0; changed(); }
export async function telegramUnlink() { await call('DELETE', '/api/telegram'); await refresh(); }

// ───────── 이메일 ─────────
export async function emailSubmit(email) {
  await call('POST', '/api/email', { email, lang: getLang() });
  await refresh();
}
export async function emailRemove() { await call('DELETE', '/api/email'); await refresh(); }

export async function sendTest() { return call('POST', '/api/test', { lang: getLang() }); }

// ───────── 알림 ─────────
/** 품절 상품 알림 등록. item 은 검색 결과 항목, rate 는 그 통화의 원화 환율 */
export async function addWatch(item, rate) {
  const url = cleanUrl(item.url);
  notify.pending.add(url); changed();
  try {
    const res = await call('POST', '/api/alerts', {
      url, storeId: item.storeId, storeName: item.storeName,
      title: item.title, vendor: item.vendor || '', variant: item.variant || '',
      size: item.size || null, category: item.category, price: item.price, currency: item.currency,
      rate: rate || null, wooId: item.wooId || null, lang: getLang(),
    });
    if (!res.duplicate) notify.alerts.unshift(res.alert);
    return res;
  } finally {
    notify.pending.delete(url); changed();
  }
}
export async function removeWatch(id) {
  const w = notify.alerts.find(x => x.id === id);
  if (w) notify.pending.add(w.url);
  changed();
  try {
    await call('DELETE', `/api/alerts/${encodeURIComponent(id)}`);
    notify.alerts = notify.alerts.filter(x => x.id !== id);
  } finally {
    if (w) notify.pending.delete(w.url);
    changed();
  }
}

// ───────── 고급 ─────────
export const deviceCode = () => notify.conf.key;
// 다른 기기의 코드를 넣으면 같은 알림 목록·연결을 같이 씀
export async function useDeviceCode(code) {
  const key = String(code || '').trim();
  if (!/^[0-9a-f]{48}$/i.test(key)) throw err('badCode');
  await rawCall('GET', '/api/me', null, key).catch(e => { throw e.code === 'auth' ? err('badCode') : e; });
  notify.conf.key = key; notify.conf.userId = '';
  await saveConf();
  await refresh();
}
export async function setServer(url) {
  let s = String(url || '').trim();
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  if (s === (ALERT_SERVER || '').replace(/\/+$/, '')) s = '';
  if (s !== notify.conf.server) { notify.conf = { server: s, userId: '', key: '' }; await saveConf(); }
  await refresh();
}
export async function deleteMe() {
  await call('DELETE', '/api/me');
  notify.conf.key = ''; notify.conf.userId = '';
  notify.me = null; notify.alerts = [];
  await saveConf();
  changed();
}

// ───────── 문구 ─────────
export const errText = (code, data) => {
  const k = 'nf.err.' + code;
  const s = t(k, data && data.max ? { max: data.max } : undefined);
  return s === k ? t('nf.err.unknown', { c: code }) : s;
};
export const sentText = v => t('nf.sent.' + (['ok', 'off'].includes(v) ? v : 'fail'));

export const ago = ts => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return t('nf.justNow');
  if (m < 60) return t('nf.minAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('nf.hourAgo', { n: h });
  return new Date(ts).toLocaleDateString(getLang() === 'ko' ? 'ko-KR' : 'en-US');
};

export function watchStateText(w) {
  if (w.lastError) return t('nf.w.error', { e: errText(w.lastError) });
  if (w.inStock) return t('nf.w.restocked', { when: ago(w.restockedAt) });
  return t('nf.w.waiting');
}
export const checkedText = w => (w.checkedAt ? t('nf.w.checked', { when: ago(w.checkedAt) }) : '');
