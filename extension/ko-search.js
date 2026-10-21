// 한글 검색어 → 영어 검색어 자동 변환
// 예: "크리드 어벤투스" → "Creed Aventus", "어벤투스" → "Creed Aventus", "르라보 상탈 33" → "Le Labo Santal 33"
import { BRANDS, FRAGS, WORDS, EN_ALIASES } from './ko-names.js';

const HANGUL = /[가-힣]/;
const squash = s => s.replace(/\s+/g, '');

// 키(띄어쓰기 없는 한글) → 후보 목록
const DICT = new Map();
let MAX_KEY = 1;
const addKey = (key, entry) => {
  const k = squash(key);
  if (!k) return;
  if (!DICT.has(k)) DICT.set(k, []);
  DICT.get(k).push(entry);
  MAX_KEY = Math.max(MAX_KEY, k.length);
};
for (const [en, ko] of BRANDS) ko.split('|').forEach(k => addKey(k, { type: 'brand', en }));
for (const [brand, list] of Object.entries(FRAGS)) {
  for (const [en, ko] of list) ko.split('|').forEach(k => addKey(k, { type: 'frag', en, brand }));
}
for (const [en, ko] of WORDS) ko.split('|').forEach(k => addKey(k, { type: 'word', en }));

// 짧은 향수 이름(예: "허", "와이")은 그 브랜드를 같이 썼을 때만 인정
const SHORT = 2;

function pick(cands, brands, key) {
  const brand = cands.find(c => c.type === 'brand');
  if (brand) return brand;
  const inBrand = cands.find(c => c.type === 'frag' && brands.has(c.brand));
  if (inBrand) return inBrand;
  const word = cands.find(c => c.type === 'word');
  if (word) return word;
  const frags = cands.filter(c => c.type === 'frag');
  if (!frags.length || key.length <= SHORT) return null;
  // 한 브랜드에만 있는 이름이면 브랜드까지 붙임, 여러 브랜드에 있으면 이름만
  const one = frags.every(f => f.brand === frags[0].brand);
  return one ? frags[0] : { type: 'word', en: frags[0].en };
}

function scan(run, brands) {
  const out = [];
  let unknown = '';
  const flush = () => { if (unknown) { out.push({ type: 'unknown', text: unknown }); unknown = ''; } };
  let i = 0;
  while (i < run.length) {
    let hit = null, len = 0;
    for (let L = Math.min(MAX_KEY, run.length - i); L >= 1; L--) {
      const key = run.substr(i, L);
      const cands = DICT.get(key);
      if (!cands) continue;
      const p = pick(cands, brands, key);
      if (p) { hit = p; len = L; break; }
    }
    if (hit) { flush(); out.push(hit); i += len; }
    else { unknown += run[i]; i += 1; }
  }
  flush();
  return out;
}

// 한글 덩어리(띄어쓰기 무시)와 나머지(영문·숫자)를 순서대로 나눠서 해석
function tokenize(q, brands) {
  const parts = [];
  for (const seg of q.match(/[가-힣]+|[^가-힣\s]+/g) || []) {
    const last = parts[parts.length - 1];
    if (HANGUL.test(seg)) {
      if (last && last.hangul) last.text += seg;
      else parts.push({ hangul: true, text: seg });
    } else parts.push({ hangul: false, text: seg });
  }
  // 1차: 브랜드 찾기 → 2차: 그 브랜드 기준으로 향수 이름 해석
  for (const p of parts) if (p.hangul) scan(p.text, brands).forEach(t => { if (t.type === 'brand') brands.add(t.en); });
  const tokens = [];
  for (const p of parts) {
    if (p.hangul) tokens.push(...scan(p.text, brands));
    else tokens.push({ type: 'literal', en: p.text });
  }
  return tokens;
}

function joinTokens(tokens) {
  const words = [];
  for (const t of tokens) {
    if (!t.en) continue;
    // 같은 단어 반복 제거
    if (words.length && words[words.length - 1].toLowerCase() === t.en.toLowerCase()) continue;
    // "바카라 루쥬 540" → 이름에 이미 들어간 숫자는 다시 붙이지 않음
    if (t.type === 'literal' && words.length && new RegExp(`(^|\\s)${t.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(words[words.length - 1])) continue;
    words.push(t.en);
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 검색창 하나에 쓴 검색어 변환 (예전 방식·최근 검색어 호환)
 * @returns {{ query: string, changed: boolean, unknown: string[] }}
 */
export function toEnglishQuery(input) {
  const q = String(input || '').trim();
  if (!HANGUL.test(q)) return { query: q, changed: false, unknown: [] };
  const brands = new Set();
  const tokens = tokenize(q, brands);
  // 향수 이름만 쓴 경우 브랜드를 앞에 붙임
  const lowerAll = () => tokens.filter(t => t.en).map(t => t.en.toLowerCase()).join(' ');
  for (const t of [...tokens]) {
    if (t.type === 'frag' && !brands.has(t.brand)) {
      brands.add(t.brand);
      if (!lowerAll().includes(t.brand.toLowerCase())) tokens.unshift({ type: 'brand', en: t.brand });
    }
  }
  const unknown = tokens.filter(t => t.type === 'unknown').map(t => t.text);
  return { query: joinTokens(tokens), changed: true, unknown };
}

// ───────── 영어 브랜드 ─────────
const lc = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’.]/g, '').replace(/\s+/g, ' ').trim();
const EN_BRAND = new Map();   // 소문자 표기 → 표준 브랜드 이름
for (const [en] of BRANDS) EN_BRAND.set(lc(en), en);
for (const [en, list] of Object.entries(EN_ALIASES)) list.forEach(a => { if (!EN_BRAND.has(lc(a))) EN_BRAND.set(lc(a), en); });

/** 결과 상품의 브랜드 확인에 쓸 표기 목록 (표준 이름 + 다른 표기) */
export function brandVariants(brand) {
  if (!brand) return [];
  const canon = EN_BRAND.get(lc(brand)) || brand;
  return [...new Set([brand, canon, ...(EN_ALIASES[canon] || [])])];
}

// 영어 검색어 앞부분이 알려진 브랜드면 나눔 ("Creed Aventus" → Creed / Aventus)
function splitBrand(text) {
  const words = text.split(/\s+/);
  for (let n = Math.min(5, words.length); n >= 1; n--) {
    const head = lc(words.slice(0, n).join(' '));
    if (EN_BRAND.has(head)) return { brand: EN_BRAND.get(head), name: words.slice(n).join(' ') };
  }
  return null;
}

/**
 * 브랜드 칸 + 향수 이름 칸 → 영어 검색어
 * 브랜드 칸이 비어 있으면 이름 칸에서 브랜드를 찾아봄 (한글 사전, 영어 브랜드 목록)
 * @returns {{ brand: string, name: string, query: string, changed: boolean, unknown: string[], brandAuto: boolean }}
 */
export function parseSearch(brandInput, nameInput) {
  const bIn = String(brandInput || '').trim();
  const nIn = String(nameInput || '').trim();
  const ctx = new Set();
  let brand = '', changed = false, brandAuto = false;
  const unknown = [];

  if (bIn) {
    if (HANGUL.test(bIn)) {
      changed = true;
      const toks = tokenize(bIn, new Set());
      const b = toks.find(t => t.type === 'brand');
      toks.filter(t => t.type === 'unknown').forEach(t => unknown.push(t.text));
      brand = b ? b.en : joinTokens(toks.filter(t => t.type === 'literal'));
    } else {
      brand = EN_BRAND.get(lc(bIn)) || bIn;
    }
    if (brand) ctx.add(brand);
  }

  let name = '';
  if (nIn) {
    if (HANGUL.test(nIn)) {
      changed = true;
      const toks = tokenize(nIn, ctx);
      toks.filter(t => t.type === 'unknown').forEach(t => unknown.push(t.text));
      // 이름 칸에 브랜드까지 쓴 경우
      const bt = toks.find(t => t.type === 'brand');
      if (bt && !brand) { brand = bt.en; brandAuto = true; }
      // 향수 이름만 쓴 경우 그 향수의 브랜드
      const ft = toks.find(t => t.type === 'frag');
      if (ft && !brand) { brand = ft.brand; brandAuto = true; }
      name = joinTokens(toks.filter(t => !(t.type === 'brand' && lc(t.en) === lc(brand))));
    } else {
      name = nIn;
    }
    if (!brand) {
      const sp = splitBrand(name);
      if (sp && sp.name) { brand = sp.brand; name = sp.name; brandAuto = true; }
    } else {
      // 이름 칸 앞에 브랜드를 또 쓴 경우 ("Creed" + "Creed Aventus")
      const sp = splitBrand(name);
      if (sp && sp.name && lc(sp.brand) === lc(EN_BRAND.get(lc(brand)) || brand)) name = sp.name;
    }
  }
  const query = [brand, name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return { brand, name, query, changed, unknown, brandAuto };
}
