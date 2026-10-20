// 한국어 / English 화면 문구
const api = globalThis.browser ?? globalThis.chrome;

const DICT = {
  ko: {
    appName: '향수 최저가',
    'popup.placeholder': '예: 제르조프 낙소스 / Xerjoff Naxos',
    'popup.search': '검색',
    'popup.open': '검색 화면 열기 · 사이트 설정',
    'search.placeholder': '브랜드 + 향수 이름 (한글·영문). 예: 퍼퓸드말리 레이튼',
    'qnote.hint': '한글로 입력해도 브랜드·향수 이름을 영어로 자동 변환해서 검색해요.',
    'qnote.conv': '영어로 바꿔서 검색: {q}',
    'qnote.unknown': '못 알아본 단어 "{w}"는 빼고 검색했어요 (영어로 입력하면 정확해요)',
    'qnote.none': '한글 이름을 영어로 바꾸지 못했어요. 브랜드와 향수 이름을 영어로 입력해 주세요.',
    'search.button': '검색',
    'opt.soldout': '품절 포함',
    'opt.loose': '숨긴 결과도 보기',
    'badge.nonfrag': '향수 아님',
    'hidden.count': '검색어와 관련 없거나 향수가 아닌 결과 {n}개를 숨겼어요.',
    'hidden.shown': '관련 없거나 향수가 아닌 결과 {n}개도 함께 보여주는 중이에요.',
    'hidden.show': '보기',
    'hidden.hide': '다시 숨기기',
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
    'err.blocked': '봇 차단 (사이트가 자동 요청을 막음)',
    'err.notjson': '응답 형식 오류',
    'err.unknown': '알 수 없는 오류',
    'status.blocked': '직접 확인 · 봇 차단',
    'status.tab': '탭에서 읽는 중',
    'status.viaTab': '탭',
    'badge.partial': '옵션 미확인 · 최저 옵션가',
    'adv.title': '고급 설정',
    'adv.tabs': '막힌 사이트는 숨은 탭으로 열어서 읽기',
    'adv.hint': '요청이 막힌 사이트만 숨은 탭으로 열고, 다 읽으면 자동으로 닫아요. 사이트당 5~20초 걸리고, 전에 탭으로 못 읽은 사이트도 매번 다시 시도하되, 순서만 뒤로 미뤄요. 아이폰에서는 탭이 잠깐 보일 수 있어요.',
    'err.tabTimeout': '탭에서 읽기 시간 초과',
    'err.noScripting': '이 Safari 버전은 탭 읽기를 지원하지 않음 (Safari 16.4 이상 필요)',
    'err.inject': '탭에 스크립트를 넣지 못함 (웹사이트 권한 확인)',
    'err.parse': '탭에서 읽은 데이터 오류',
    'search.running': '검색 중…',
    'prog.running': '검색 중 · {done}/{total}곳 확인',
    'prog.done': '검색 완료 · {total}곳 확인',
    'prog.stopped': '검색 중지됨 · {done}/{total}곳 확인',
    'prog.inTab': '탭에서 읽는 중 {n}곳',
    'prog.tabWait': '탭 대기 {n}곳',
    'prog.found': '결과 {n}개',
    'prog.secs': '{n}초',
    'prog.needCheck': '직접 확인 {n}곳',
    'prog.stop': '중지',
    'prog.stopping': '중지하는 중…',
    'status.tabWait': '탭 대기',
    'status.stopped': '중지됨',
    'status.skipped': '최근 탭 실패로 건너뜀',
    'status.fetchNote': '바로 요청은 실패({why}) → 탭으로 읽음',
    'errShort.nodata': '가격 데이터 없음',
    'errShort.timeout': '시간 초과',
    'errShort.tabTimeout': '탭 시간 초과',
    'errShort.pageFailed': '페이지 열기 실패',
    'errShort.blocked': '봇 차단',
    'errShort.inject': '스크립트 실행 불가',
    'errShort.noScripting': '탭 읽기 미지원',
    'errShort.notjson': '응답 형식 오류',
    'errShort.parse': '데이터 오류',
    'errShort.unknown': '원인 불명',
    'err.pageFailed': '탭에서 페이지가 열리지 않음 (사이트 주소 또는 네트워크 문제)',
    'access.title': '확장이 사이트에 접속하지 못하고 있어요',
    'access.step1': 'Safari › 설정 › 확장 프로그램 › 향수 최저가 › 웹사이트 편집에서 "다른 웹사이트"가 "허용"인지 확인',
    'access.step2': '허용인데도 이 안내가 뜨면 Safari를 완전히 종료(⌘Q)했다가 다시 열기. 확장을 업데이트하거나 껐다 켠 직후 Safari가 확장의 접속을 막아두는 경우가 있어요',
    'access.step3': '다시 연 뒤 설정 › 개발자 › "서명되지 않은 확장 프로그램 허용"을 다시 체크 (아이폰: 설정 › 앱 › Safari › 확장 프로그램 › 향수 최저가 › 기타 웹사이트 › 허용)',
    'access.request': '권한 요청하고 다시 검색',
    'access.retry': '설정 바꿨어요, 다시 검색',
    'errShort.noAccess': '사이트 접근 권한 없음',
    'errShort.network': '연결 실패',
    'err.noAccess': 'Safari 설정에서 이 확장의 웹사이트 접근을 허용해야 해요',
    'err.network': '응답 없이 연결이 끊김 (네트워크 또는 Safari 권한 문제)',
    'lang.label': '언어',
  },
  en: {
    appName: 'Scent Price Finder',
    'popup.placeholder': 'e.g. Xerjoff Naxos (Korean names OK)',
    'popup.search': 'Search',
    'popup.open': 'Open search page · Site settings',
    'search.placeholder': 'Brand + fragrance name (English or Korean). e.g. Parfums de Marly Layton',
    'qnote.hint': 'Korean brand and fragrance names are converted to English automatically.',
    'qnote.conv': 'Searching in English: {q}',
    'qnote.unknown': 'left out unrecognized word(s) "{w}" (typing in English is more accurate)',
    'qnote.none': 'Couldn\'t convert the Korean name to English. Please type the brand and fragrance name in English.',
    'search.button': 'Search',
    'opt.soldout': 'Include sold out',
    'opt.loose': 'Show hidden results',
    'badge.nonfrag': 'Not fragrance',
    'hidden.count': '{n} unrelated or non-fragrance results are hidden.',
    'hidden.shown': 'Also showing {n} unrelated or non-fragrance results.',
    'hidden.show': 'Show',
    'hidden.hide': 'Hide again',
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
    'err.blocked': 'Blocked by bot protection (site refuses automated requests)',
    'err.notjson': 'Unexpected response',
    'err.unknown': 'Unknown error',
    'status.blocked': 'check manually · bot-blocked',
    'status.tab': 'reading in tab',
    'status.viaTab': 'tab',
    'badge.partial': 'options unverified · lowest option price',
    'adv.title': 'Advanced',
    'adv.tabs': 'Read blocked stores in a background tab',
    'adv.hint': 'Only stores whose requests are blocked open in a background tab, which closes automatically. Each takes 5–20 s; stores that failed in a tab before are still retried every time, just last. On iPhone the tab may be briefly visible.',
    'err.tabTimeout': 'Timed out reading in tab',
    'err.noScripting': 'This Safari version cannot read pages in tabs (Safari 16.4+ required)',
    'err.inject': 'Could not run script in tab (check website permissions)',
    'err.parse': 'Invalid data read from tab',
    'search.running': 'Searching…',
    'prog.running': 'Searching · {done}/{total} stores checked',
    'prog.done': 'Search complete · {total} stores checked',
    'prog.stopped': 'Search stopped · {done}/{total} stores checked',
    'prog.inTab': 'reading {n} in tabs',
    'prog.tabWait': '{n} waiting for a tab',
    'prog.found': '{n} results',
    'prog.secs': '{n}s',
    'prog.needCheck': '{n} to check manually',
    'prog.stop': 'Stop',
    'prog.stopping': 'Stopping…',
    'status.tabWait': 'waiting for tab',
    'status.stopped': 'stopped',
    'status.skipped': 'skipped after recent tab failures',
    'status.fetchNote': 'Direct request failed ({why}) → read in tab',
    'errShort.nodata': 'no price data',
    'errShort.timeout': 'timed out',
    'errShort.tabTimeout': 'tab timed out',
    'errShort.pageFailed': 'page failed to open',
    'errShort.blocked': 'bot-blocked',
    'errShort.inject': 'script blocked',
    'errShort.noScripting': 'tabs unsupported',
    'errShort.notjson': 'bad response',
    'errShort.parse': 'bad data',
    'errShort.unknown': 'unknown',
    'err.pageFailed': 'The page did not open in the tab (address or network problem)',
    'access.title': 'The extension cannot reach any websites',
    'access.step1': 'Safari › Settings › Extensions › Scent Price Finder › Edit Websites: make sure "Other Websites" is "Allow"',
    'access.step2': 'If it already is, quit Safari completely (⌘Q) and reopen it. Right after an extension update or re-enable, Safari can keep the extension offline',
    'access.step3': 'After reopening, re-check Settings › Developer › "Allow unsigned extensions" (iPhone: Settings › Apps › Safari › Extensions › Scent Price Finder › Other Websites › Allow)',
    'access.request': 'Request access and search again',
    'access.retry': "I've changed it, search again",
    'errShort.noAccess': 'no website access',
    'errShort.network': 'connection failed',
    'err.noAccess': 'Allow website access for this extension in Safari settings',
    'err.network': 'Connection dropped without a response (network or Safari permission)',
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
