import { initLang, applyStatic, mountLangSwitch } from './i18n.js';

const api = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);

// 검색 화면 열기: ?b=브랜드&n=향수 이름
function openApp(b, n) {
  const qs = new URLSearchParams();
  if (b) qs.set('b', b);
  if (n) qs.set('n', n);
  const s = qs.toString();
  api.tabs.create({ url: api.runtime.getURL('app.html') + (s ? `?${s}` : '') });
  window.close();
}

$('f').addEventListener('submit', e => {
  e.preventDefault();
  const b = $('b').value.trim(), n = $('q').value.trim();
  if (b || n) openApp(b, n);
});
$('open').addEventListener('click', () => openApp('', ''));

(async () => {
  await initLang();
  applyStatic();
  mountLangSwitch($('langSwitch'), () => applyStatic());
  try {
    const { recent = [] } = await api.storage.local.get('recent');
    const box = $('recent');
    recent.slice(0, 6).forEach(r => {
      // 예전 버전은 문자열 하나로 저장
      const { b = '', n = '' } = typeof r === 'string' ? { n: r } : r;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = [b, n].filter(Boolean).join(' · ');
      btn.addEventListener('click', () => openApp(b, n));
      box.appendChild(btn);
    });
  } catch { /* 무시 */ }
})();
