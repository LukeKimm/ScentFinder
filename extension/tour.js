// 처음 쓰는 사람을 위한 사용법 둘러보기
// 화면의 실제 버튼·칸을 차례로 비추고, 옆에 설명 카드를 띄움. 언제든 "건너뛰기"로 끝낼 수 있음.
import { t } from './i18n.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);

// target: 비출 요소(없으면 화면 가운데 카드). before: 그 단계 전에 할 일
const STEPS = [
  { key: 'welcome' },
  { key: 'search', target: () => $('searchForm') },
  { key: 'filters', target: () => document.querySelector('.controls .chips') },
  { key: 'options', target: () => document.querySelector('.selects') },
  { key: 'results', preview: true },
  { key: 'history', target: () => $('openHistory') },
  { key: 'settings', target: () => $('openSettings') },
  { key: 'done' },
];

let el = null, idx = 0, onEnd = null, raf = 0;

export async function shouldShowTour() {
  try { const { tourDone } = await api.storage.local.get('tourDone'); return !tourDone; } catch { return false; }
}

export function startTour(done) {
  if (el) return;
  onEnd = done || null;
  idx = 0;
  el = document.createElement('div');
  el.className = 'tour';
  el.innerHTML = `
    <div class="tourSpot" aria-hidden="true"></div>
    <div class="tourCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText">
      <div class="tourPreview" aria-hidden="true"></div>
      <div class="tourStep"></div>
      <h2 id="tourTitle" class="tourTitle"></h2>
      <p id="tourText" class="tourText"></p>
      <div class="tourBtns">
        <button type="button" class="tourSkip"></button>
        <span class="tourNav">
          <button type="button" class="tourPrev"></button>
          <button type="button" class="tourNext"></button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.tourSkip').addEventListener('click', () => end());
  el.querySelector('.tourPrev').addEventListener('click', () => go(idx - 1));
  el.querySelector('.tourNext').addEventListener('click', () => (idx >= STEPS.length - 1 ? end() : go(idx + 1)));
  addEventListener('resize', place);
  addEventListener('scroll', place, { passive: true });
  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('touring');
  go(0);
  requestAnimationFrame(() => el && el.classList.add('in'));
}

function onKey(e) {
  if (!el) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
  else if (e.key === 'ArrowRight') go(Math.min(idx + 1, STEPS.length - 1));
  else if (e.key === 'ArrowLeft') go(Math.max(idx - 1, 0));
}

function go(i) {
  if (!el || i < 0 || i >= STEPS.length) return;
  idx = i;
  const s = STEPS[i];
  const last = i === STEPS.length - 1;
  el.querySelector('.tourStep').textContent = i === 0 || last ? '' : t('tour.step', { n: i, total: STEPS.length - 2 });
  el.querySelector('.tourTitle').textContent = t(`tour.${s.key}.title`);
  el.querySelector('.tourText').textContent = t(`tour.${s.key}.text`);
  el.querySelector('.tourSkip').textContent = t('tour.skip');
  el.querySelector('.tourSkip').hidden = last;
  el.querySelector('.tourPrev').textContent = t('tour.prev');
  el.querySelector('.tourPrev').hidden = i === 0 || last;
  el.querySelector('.tourNext').textContent = i === 0 ? t('tour.start') : last ? t('tour.finish') : t('tour.next');
  const pv = el.querySelector('.tourPreview');
  pv.hidden = !s.preview;
  if (s.preview) pv.innerHTML = `
    <div class="pvLabel"><span class="pvLbl">${t('best.label')}</span><span class="pvVal">₩197,425</span><span class="pvTtl">Amouage Interlude Man</span></div>
    <div class="pvRow"><span class="pvThumb"></span><span class="pvLines"><i></i><i></i></span><span class="pvPrice">₩209,350</span></div>
    <div class="pvRow"><span class="pvThumb"></span><span class="pvLines"><i></i><i></i></span><span class="pvPrice">₩218,625</span></div>`;
  const target = s.target && s.target();
  if (target && target.getBoundingClientRect().height) {
    const r = target.getBoundingClientRect();
    // 머리(검색창 등)는 늘 위에 붙어 있음. 아래쪽 요소면 보이도록 스크롤
    if (r.top < 0 || r.bottom > innerHeight - 220) target.scrollIntoView({ block: 'center' });
  }
  place();
  el.querySelector('.tourNext').focus({ preventScroll: true });
}

function place() {
  if (!el) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    if (!el) return;
    const s = STEPS[idx];
    const spot = el.querySelector('.tourSpot');
    const card = el.querySelector('.tourCard');
    const target = s.target && s.target();
    const r = target && target.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const cw = Math.min(380, vw - 32);
    card.style.width = cw + 'px';
    if (!r || !r.height) {
      // 비출 곳이 없는 단계: 화면 가운데
      el.classList.add('center');
      spot.style.cssText = '';
      card.style.left = (vw - cw) / 2 + 'px';
      card.style.top = Math.max(16, (vh - card.offsetHeight) / 2) + 'px';
      return;
    }
    el.classList.remove('center');
    const pad = 6;
    const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
    const w = Math.min(vw - 8, r.right + pad) - x, h = r.bottom + pad - y;
    const radius = target.matches('.iconBtn') ? 999 : 16;
    spot.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${radius}px`;
    // 카드는 비춘 곳 아래(공간이 없으면 위)에, 가로는 비춘 곳에 맞춤
    const ch = card.offsetHeight;
    const below = y + h + 12;
    const top = below + ch <= vh - 12 ? below : Math.max(12, y - 12 - ch);
    const left = Math.min(Math.max(16, x + w / 2 - cw / 2), vw - cw - 16);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  });
}

async function end() {
  if (!el) return;
  const node = el;
  el = null;
  removeEventListener('resize', place);
  removeEventListener('scroll', place);
  document.removeEventListener('keydown', onKey, true);
  document.documentElement.classList.remove('touring');
  node.classList.remove('in');
  setTimeout(() => node.remove(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
  try { await api.storage.local.set({ tourDone: true }); } catch { /* 무시 */ }
  if (onEnd) onEnd();
}
