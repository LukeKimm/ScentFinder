import { initLang, applyStatic, mountLangSwitch } from './i18n.js';

const api = globalThis.browser ?? globalThis.chrome;

function openApp(q) {
  const url = api.runtime.getURL('app.html') + (q ? `?q=${encodeURIComponent(q)}` : '');
  api.tabs.create({ url });
  window.close();
}

document.getElementById('f').addEventListener('submit', e => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (q) openApp(q);
});
document.getElementById('open').addEventListener('click', () => openApp(''));

(async () => {
  await initLang();
  applyStatic();
  mountLangSwitch(document.getElementById('langSwitch'), () => applyStatic());
  try {
    const { recent = [] } = await api.storage.local.get('recent');
    const box = document.getElementById('recent');
    recent.slice(0, 6).forEach(q => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = q;
      b.addEventListener('click', () => openApp(q));
      box.appendChild(b);
    });
  } catch { /* 무시 */ }
})();
