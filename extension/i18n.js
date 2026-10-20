// 한국어 / English 화면 문구
const api = globalThis.browser ?? globalThis.chrome;

const DICT = {
  ko: {
    appName: '향수 최저가',
    'popup.placeholder': '예: Xerjoff Naxos 100ml',
    'popup.search': '검색',
    'popup.open': '검색 화면 열기 · 사이트 설정',
    'search.placeholder': '브랜드 + 향수 이름 (영문). 예: Parfums de Marly Layton',
    'search.button': '검색',
    'opt.soldout': '품절 포함',
    'opt.loose': '관련도 낮은 결과도 보기',
    'sort.label': '정렬',
    'sort.krw': '원화 최저가',
    'sort.perml': 'ml당 가격',
    'sort.store': '사이트별',
    'size.label': '용량',
    'size.all': '전체',
    'stores.title': '검색할 사이트',
    'stores.add.title': '사이트 추가 (Shopify·WooCommerce 몰은 자동 인식)',
    'stores.add.name': '이름',
    'stores.add.domain': '도메인 (예: example.com)',
    'stores.add.button': '추가',
    'stores.redetect': '사이트 방식 다시 판별',
    'stores.allOn': '전체 선택',
    'stores.allOff': '전체 해제',
    'stores.url': 'URL',
    'stores.delete': '삭제',
    'stores.save': '저장',
    'stores.urlHint': '{q} 자리에 검색어가 들어갑니다',
    'mode.auto': '자동',
    'mode.html': '페이지 분석',
    'rates.title': '환율',
    'rates.unit': '원',
    'rates.hint': '비워두면 자동 환율을 씁니다. 배송비·관부가세는 포함되지 않은 상품가 기준이에요.',
    'rates.manual': '수동',
    'rates.auto': '자동',
    'rates.default': '기본값',
    'region.US': '미국', 'region.UK': '영국', 'region.CA': '캐나다', 'region.EU': '유럽', 'region.ETC': '기타',
    'cat.boxed': '정품 박스', 'cat.tester': '테스터', 'cat.unboxed': '언박스', 'cat.sample': '미니·샘플·디캔트', 'cat.set': '세트',
    'catShort.boxed': '정품', 'catShort.tester': '테스터', 'catShort.unboxed': '언박스', 'catShort.sample': '미니/샘플', 'catShort.set': '세트',
    'conc.extrait': '엑스트레', 'conc.parfum': '퍼퓸',
    'badge.soldout': '품절',
    'badge.lowrel': '관련도 낮음',
    'status.check': '직접 확인',
    'status.fail': '실패',
    'status.openAll': '직접 확인할 사이트 {n}곳 탭으로 열기',
    'best.label': '현재 조건 최저가',
    'best.running': ' (검색 중)',
    'best.open': '열기',
    'perml': 'ml당 {v}',
    'empty.start': '브랜드와 향수 이름을 영문으로 검색해 보세요.',
    'empty.filtered': '필터 조건에 맞는 결과가 없어요. 위 필터를 조정해 보세요.',
    'empty.none': '결과가 없어요. 철자를 확인하거나 브랜드명을 빼고 검색해 보세요.',
    'err.timeout': '시간 초과',
    'err.blocked': '봇 차단',
    'err.notjson': '응답 형식 오류',
    'err.unknown': '알 수 없는 오류',
    'lang.label': '언어',
  },
  en: {
    appName: 'Scent Price Finder',
    'popup.placeholder': 'e.g. Xerjoff Naxos 100ml',
    'popup.search': 'Search',
    'popup.open': 'Open search page · Site settings',
    'search.placeholder': 'Brand + fragrance name. e.g. Parfums de Marly Layton',
    'search.button': 'Search',
    'opt.soldout': 'Include sold out',
    'opt.loose': 'Show less relevant results',
    'sort.label': 'Sort',
    'sort.krw': 'Lowest price (KRW)',
    'sort.perml': 'Price per ml',
    'sort.store': 'By store',
    'size.label': 'Size',
    'size.all': 'All',
    'stores.title': 'Stores to search',
    'stores.add.title': 'Add a store (Shopify & WooCommerce stores are detected automatically)',
    'stores.add.name': 'Name',
    'stores.add.domain': 'Domain (e.g. example.com)',
    'stores.add.button': 'Add',
    'stores.redetect': 'Re-detect store types',
    'stores.allOn': 'Select all',
    'stores.allOff': 'Deselect all',
    'stores.url': 'URL',
    'stores.delete': 'Delete',
    'stores.save': 'Save',
    'stores.urlHint': '{q} is replaced with your search term',
    'mode.auto': 'Auto',
    'mode.html': 'Page parsing',
    'rates.title': 'Exchange rates',
    'rates.unit': 'KRW',
    'rates.hint': 'Leave blank to use live rates. Prices exclude shipping, duties and taxes.',
    'rates.manual': 'manual',
    'rates.auto': 'live',
    'rates.default': 'default',
    'region.US': 'United States', 'region.UK': 'United Kingdom', 'region.CA': 'Canada', 'region.EU': 'Europe', 'region.ETC': 'Other',
    'cat.boxed': 'Boxed', 'cat.tester': 'Tester', 'cat.unboxed': 'Unboxed', 'cat.sample': 'Mini / Sample / Decant', 'cat.set': 'Gift set',
    'catShort.boxed': 'Boxed', 'catShort.tester': 'Tester', 'catShort.unboxed': 'Unboxed', 'catShort.sample': 'Mini/Sample', 'catShort.set': 'Set',
    'conc.extrait': 'Extrait', 'conc.parfum': 'Parfum',
    'badge.soldout': 'Sold out',
    'badge.lowrel': 'Low relevance',
    'status.check': 'check manually',
    'status.fail': 'failed',
    'status.openAll': 'Open {n} stores to check manually in tabs',
    'best.label': 'Lowest price for current filters',
    'best.running': ' (searching)',
    'best.open': 'Open',
    'perml': '{v} / ml',
    'empty.start': 'Search by brand and fragrance name.',
    'empty.filtered': 'No results match your filters. Try adjusting them above.',
    'empty.none': 'No results. Check the spelling or try without the brand name.',
    'err.timeout': 'Timed out',
    'err.blocked': 'Blocked by bot protection',
    'err.notjson': 'Unexpected response',
    'err.unknown': 'Unknown error',
    'lang.label': 'Language',
  },
};

export const LANGS = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
];

let lang = 'ko';

export async function initLang() {
  try {
    const { lang: saved } = await api.storage.local.get('lang');
    if (saved && DICT[saved]) { lang = saved; return lang; }
  } catch { /* 무시 */ }
  lang = (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  return lang;
}

export function getLang() { return lang; }

export async function setLang(code) {
  if (!DICT[code]) return;
  lang = code;
  try { await api.storage.local.set({ lang: code }); } catch { /* 무시 */ }
}

export function t(key, vars) {
  let s = DICT[lang][key] ?? DICT.ko[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

export const numLocale = () => (lang === 'ko' ? 'ko-KR' : 'en-US');

// data-i18n / data-i18n-ph / data-i18n-title 속성이 붙은 요소에 문구 적용
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
}

// 언어 전환 버튼 (한국어 | English)
export function mountLangSwitch(container, onChange) {
  container.innerHTML = '';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', t('lang.label'));
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.label;
    b.setAttribute('aria-pressed', String(l.code === lang));
    b.addEventListener('click', async () => {
      if (l.code === lang) return;
      await setLang(l.code);
      mountLangSwitch(container, onChange);
      onChange?.(l.code);
    });
    container.appendChild(b);
  }
}
