// 상품명 → 용량(ml), 종류(정품/테스터/언박스/미니·샘플/세트) 판별, 검색어 관련도 계산

// 표시 이름은 i18n.js의 cat.* / catShort.* 문구 사용
export const CATEGORIES = ['boxed', 'tester', 'unboxed', 'sample', 'set'];

const STD_SIZES = [1, 1.5, 2, 3, 5, 7.5, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60, 65, 70, 75, 80, 85, 90,
  100, 106, 110, 120, 125, 150, 180, 200, 250, 300, 500];

// oz 환산값을 가장 가까운 표준 용량으로 (오차 4% 이내일 때만)
function snap(ml) {
  let best = null, bestErr = Infinity;
  for (const s of STD_SIZES) {
    const err = Math.abs(ml - s) / s;
    if (err < bestErr) { best = s; bestErr = err; }
  }
  return bestErr <= 0.04 ? best : Math.round(ml);
}

export function extractSize(...texts) {
  for (const raw of texts) {
    if (!raw) continue;
    const t = String(raw).replace(/(\d),(\d)/g, '$1.$2');
    const ml = t.match(/(\d+(?:\.\d+)?)\s*-?\s*ml\b/i);
    if (ml) return Math.round(parseFloat(ml[1]) * 10) / 10;
  }
  for (const raw of texts) {
    if (!raw) continue;
    const t = String(raw);
    const oz = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:fl\.?\s*)?oz\b/i);
    if (oz) return snap(parseFloat(oz[1]) * 29.5735);
  }
  return null;
}

const RE_SAMPLE = /\b(decants?|samples?|vials?|split|atomi[sz]er|travel\s*(spray|size)|miniatures?|mini|carded)\b/i;
const RE_SET = /\b(gift\s*set|coffret|\d\s*-?\s*(pc|pcs|piece)s?\b|set\s+(of|for)|discovery\s*set|\bset\b)/i;
const RE_TESTER = /\btesters?\b/i;
const RE_UNBOXED = /\b(unbox(ed)?|no\s*box|without\s*box|w\/?o\s*box|box\s*less|boxless|no\s*cap|without\s*cap|scratch(ed)?|damaged\s*box)\b/i;
// 향수가 아닌 품목 (바디·헤어·면도·스킨케어·메이크업·홈 향·액세서리·기프트카드)
const RE_NONFRAG = new RegExp('\\b(' + [
  'deodorants?', 'deo\\s*(stick|spray|roll-?on)', 'anti-?perspirants?', 'roll-?on\\s*deo',
  'body\\s*(lotion|wash|cream|mist|spray|oil|milk|butter|scrub|powder|gel|balm|souffle|emulsion)',
  'hand\\s*(cream|wash|lotion|balm|soap)', 'shower\\s*(gel|cream|oil)', 'bath\\s*(gel|oil|salts?|bombs?|foam|soak)',
  '(after|pre)\\s*-?\\s*shave\\s*(balm|cream|gel|emulsion)', 'shav(e|ing)\\s*(cream|foam|gel|soap|brush)', 'razors?', 'beard\\s*(oil|balm)',
  'hair\\s*(mist|perfume|oil|spray)', 'shampoos?', 'conditioners?', 'soaps?',
  'candles?', 'diffusers?', 'room\\s*(spray|mist)', 'home\\s*(fragrance|spray)', 'incense', 'sachets?', 'car\\s*(fragrance|freshener)',
  'lip\\s*(stick|gloss|balm|liner|colou?r|oil)', 'lipsticks?', 'mascara', 'foundation', 'concealer', 'eye\\s*(shadow|liner|cream)', 'eyeliner', 'bronzer', 'highlighter',
  'nail\\s*(polish|lacquer|colou?r)', 'serums?', 'moisturi[sz]er', 'cleanser', 'toner', 'face\\s*(cream|mask|wash|oil)', 'sunscreen', 'spf\\s*\\d+',
  'gift\\s*cards?', 'e-?gift', 'gift\\s*(wrap|wrapping)', 'tote(\\s*bag)?', 'cosmetic\\s*bag', 'key\\s*chain', 'keychain', 'sunglasses', 'wallet',
  'empty\\s*(bottle|atomi[sz]er|vial)', 'funnel', 't-?shirt', 'hoodie',
].join('|') + ')\\b', 'i');
// 쇼핑몰이 붙인 상품 분류(Shopify product_type 등)
const RE_NONFRAG_TYPE = /(skin\s*care|make-?up|cosmetic|bath\s*(&|and)?\s*body|body\s*care|hair\s*care|candle|home\s*(fragrance|scent)|gift\s*card|accessor(y|ies)|apparel|deodorant|shav(e|ing))/i;
// 향수가 들어간 세트는 바디로션이 같이 있어도 향수로 봄
const RE_FRAGWORD = /\b(eau\s*de|edp|edt|edc|parfum|extrait|cologne|fragrance|perfume)\b/i;

export function classify({ title = '', variant = '', type = '' }, size) {
  const text = `${title} ${variant} ${type}`;
  if (RE_SAMPLE.test(text)) return 'sample';
  if (RE_SET.test(`${title} ${variant}`)) return 'set';
  if (RE_TESTER.test(text)) return 'tester';
  if (RE_UNBOXED.test(text)) return 'unboxed';
  if (size != null && size <= 15) return 'sample';
  return 'boxed';
}

export function isNonFragrance({ title = '', variant = '', type = '' }) {
  if (type && RE_NONFRAG_TYPE.test(type) && !RE_FRAGWORD.test(title)) return true;
  // 옵션 이름은 짧을 때만 봄 (카드 전체 글자에는 "사은품 바디로션" 같은 문구가 섞일 수 있음)
  const v = variant && variant.length <= 60 ? variant : '';
  const text = `${title} ${v}`;
  if (!RE_NONFRAG.test(text)) return false;
  if (RE_SET.test(text) && RE_FRAGWORD.test(text)) return false;
  return true;
}

// 농도 표시 (EDP/EDT/Extrait 등)
export function extractConcentration(text = '') {
  const t = text.toLowerCase();
  if (/extrait|pure\s*parfum|parfum\s*extrait/.test(t)) return 'extrait';
  if (/eau\s*de\s*parfum|\bedp\b/.test(t)) return 'EDP';
  if (/eau\s*de\s*toilette|\bedt\b/.test(t)) return 'EDT';
  if (/eau\s*de\s*cologne|\bedc\b/.test(t)) return 'EDC';
  if (/\bparfum\b|\belixir\b/.test(t)) return 'parfum';
  return '';
}

export function normalize(s = '') {
  return String(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .trim();
}

const STOP = new Set(['by', 'for', 'the', 'de', 'eau', 'parfum', 'perfume', 'cologne', 'spray', 'edp', 'edt', 'ml', 'oz', 'men', 'women', 'man', 'woman', 'and']);

const queryTokens = q => normalize(q).split(' ').filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

// 0~1. 검색어 핵심 단어가 상품명·브랜드에 얼마나 포함되는지
export function relevance(query, ...fields) {
  const qTokens = queryTokens(query);
  if (!qTokens.length) return 1;
  const hay = ' ' + normalize(fields.join(' ')) + ' ';
  const squashed = hay.replace(/\s+/g, '');
  let hit = 0;
  for (const w of qTokens) {
    if (hay.includes(' ' + w + ' ') || hay.includes(' ' + w)) hit += 1;
    else if (squashed.includes(w)) hit += 0.8;
  }
  return hit / qTokens.length;
}

// 상품 관련도: 상품명·브랜드(core)에 검색어 절반 이상이 있어야 하고, 그때만 옵션·카드 글자(extra)까지 보태서 계산.
// (카드 주변 글자나 "검색: amouage interlude" 같은 문구만으로 엉뚱한 상품이 통과하지 않게)
export function itemRelevance(query, core, extra) {
  const c = relevance(query, ...core);
  if (c < 0.5) return c;
  return Math.max(c, relevance(query, ...core, ...extra));
}
