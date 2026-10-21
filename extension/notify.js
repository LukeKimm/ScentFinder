// 재입고 알림 (개발판) — 알림 서버(Cloudflare Workers)와 통신
// 서버 코드와 설치 방법: server/README.md
import { t, getLang } from './i18n.js';

const api = globalThis.browser ?? globalThis.chrome;
const TIMEOUT = 25000;

export const notify = {
  conf: { server: '', token: '' },
  watches: [],          // 서버에 등록된 알림
  status: null,         // /api/status 결과
  error: '',            // 마지막 연결 오류 코드
  pending: new Set(),   // 등록·해제 중인 상품 주소
  onChange: () => {},
};

const cleanUrl = u => String(u || '').split('#')[0];
export const configured = () => !!(notify.conf.server && notify.conf.token);
export const watchFor = url => notify.watches.find(w => w.url === cleanUrl(url));

async function call(method, path, body) {
  if (!configured()) throw Object.assign(new Error('notSet'), { code: 'notSet' });
  const base = notify.conf.server.replace(/\/+$/, '');
  let r;
  try {
    r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${notify.conf.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT) : undefined,
    });
  } catch {
    throw Object.assign(new Error('server'), { code: 'server' });
  }
  let data = null;
  try { data = await r.json(); } catch { /* 서버가 아닌 주소 */ }
  if (!data) throw Object.assign(new Error('server'), { code: 'server' });
  if (r.status === 401) throw Object.assign(new Error('auth'), { code: 'auth' });
  if (!data.ok) throw Object.assign(new Error(data.error || 'server'), { code: data.error || 'server', data });
  return data;
}

export async function loadConf() {
  try {
    const { notify: c } = await api.storage.local.get('notify');
    if (c) notify.conf = { server: c.server || '', token: c.token || '' };
  } catch { /* 무시 */ }
}

export async function saveConf(server, token) {
  let s = String(server || '').trim();
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  notify.conf = { server: s.replace(/\/+$/, ''), token: String(token || '').trim() };
  try { await api.storage.local.set({ notify: notify.conf }); } catch { /* 무시 */ }
}

// 상태 + 알림 목록 새로 받기
export async function refresh() {
  if (!configured()) { notify.status = null; notify.watches = []; notify.error = ''; notify.onChange(); return; }
  try {
    const [st, list] = await Promise.all([call('GET', '/api/status'), call('GET', '/api/watches')]);
    notify.status = st;
    notify.watches = list.watches || [];
    notify.error = '';
  } catch (e) {
    notify.status = null;
    notify.error = e.code || 'server';
  }
  notify.onChange();
}

export async function linkTelegram() {
  return call('POST', '/api/telegram/link', { lang: getLang() });
}

export async function sendTest() {
  return call('POST', '/api/test', { lang: getLang() });
}

/** 품절 상품 알림 등록. item 은 검색 결과 항목, rate 는 그 통화의 원화 환율 */
export async function addWatch(item, rate) {
  const url = cleanUrl(item.url);
  notify.pending.add(url);
  notify.onChange();
  try {
    const res = await call('POST', '/api/watches', {
      url, storeId: item.storeId, storeName: item.storeName,
      title: item.title, vendor: item.vendor || '', variant: item.variant || '',
      size: item.size || null, category: item.category, price: item.price, currency: item.currency,
      rate: rate || null, wooId: item.wooId || null, lang: getLang(),
    });
    if (!res.duplicate) notify.watches.unshift(res.watch);
    return res;
  } finally {
    notify.pending.delete(url);
    notify.onChange();
  }
}

export async function removeWatch(id) {
  const w = notify.watches.find(x => x.id === id);
  if (w) notify.pending.add(w.url);
  notify.onChange();
  try {
    await call('DELETE', `/api/watches/${encodeURIComponent(id)}`);
    notify.watches = notify.watches.filter(x => x.id !== id);
  } finally {
    if (w) notify.pending.delete(w.url);
    notify.onChange();
  }
}

// ───────── 문구 ─────────
export const errText = code => {
  const k = 'nf.err.' + code;
  const s = t(k);
  return s === k ? t('nf.err.unknown', { c: code }) : s;
};
export const sentText = v => t('nf.sent.' + (['ok', 'off', 'notLinked'].includes(v) ? v : 'fail'));

const ago = ts => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return t('nf.justNow');
  if (m < 60) return t('nf.minAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('nf.hourAgo', { n: h });
  return new Date(ts).toLocaleDateString(getLang() === 'ko' ? 'ko-KR' : 'en-US');
};

export function statusLine() {
  if (!configured()) return t('nf.notSet');
  if (notify.error) return errText(notify.error);
  const s = notify.status;
  if (!s) return t('nf.loading');
  return t('nf.statusLine', {
    tg: s.telegram ? t('nf.tgOn', { name: s.telegramName || '' }) : (s.telegramToken ? t('nf.tgNotLinked') : t('nf.tgOff')),
    mail: s.email ? t('nf.mailOn', { to: s.emailTo }) : t('nf.mailOff'),
    n: s.watches,
    last: s.lastRun ? ago(s.lastRun.at) : t('nf.never'),
  });
}

export function watchStateText(w) {
  if (w.lastError) return t('nf.w.error', { e: errText(w.lastError) });
  if (w.inStock) return t('nf.w.restocked', { when: ago(w.restockedAt) });
  return t('nf.w.waiting');
}
export const checkedText = w => (w.checkedAt ? t('nf.w.checked', { when: ago(w.checkedAt) }) : '');
