// 검색 대상 사이트 목록
// type: 'auto'    → Shopify → WooCommerce → HTML 순서로 자동 판별
//       'shopify' → /search/suggest.json + /products/{handle}.js
//       'woo'     → /wp-json/wc/store/v1/products
//       'html'    → 검색 페이지의 구조화 데이터(JSON-LD 등) 파싱, 실패 시 "직접 확인" 링크
// searchUrl: 사이트에서 직접 검색할 때 쓰는 주소 ({q} 자리에 검색어). 설정에서 수정 가능.
// defaultOff: 처음엔 꺼진 상태 / tabOnly: 요청 없이 바로 숨은 탭으로 읽음
// productPattern: html 방식에서 검색 결과의 상품 링크를 골라낼 정규식 (상품 페이지까지 들어가 가격을 읽음)

// 지역 이름은 i18n.js의 region.* 문구 사용
export const REGIONS = {
  US: { flag: '🇺🇸' },
  UK: { flag: '🇬🇧' },
  CA: { flag: '🇨🇦' },
  EU: { flag: '🇪🇺' },
  ETC: { flag: '🌐' },
};

export const DEFAULT_STORES = [
  // ── 미국: 대형 할인몰 ──
  { id: 'fragrancenet', name: 'FragranceNet', domain: 'www.fragrancenet.com', region: 'US', type: 'html',
    searchUrl: 'https://www.fragrancenet.com/search/{q}',
    productPattern: '^https://www\\.fragrancenet\\.com/(cologne|perfume|fragrances)/[^/]+/[^/]+' },
  { id: 'fragrancex', name: 'FragranceX', domain: 'www.fragrancex.com', region: 'US', type: 'html',
    searchUrl: 'https://www.fragrancex.com/search/search_results?stext={q}',
    productPattern: '^https://www\\.fragrancex\\.com/products/[^/]+/[^/?#]+$' },
  { id: 'perfumecom', name: 'Perfume.com', domain: 'www.perfume.com', region: 'US', type: 'html',
    searchUrl: 'https://www.perfume.com/search/search_results?stext={q}',
    productPattern: '^https://www\\.perfume\\.com/[^/]+/[^/]+/(men-cologne|women-perfume|unisex)' },
  // 가격을 자바스크립트로 그려서 요청만으로는 못 읽음 → 바로 숨은 탭으로 읽기
  { id: 'jomashop', name: 'Jomashop', domain: 'www.jomashop.com', region: 'US', type: 'html', tabOnly: true,
    searchUrl: 'https://www.jomashop.com/search?q={q}' },
  { id: 'maxaroma', name: 'MaxAroma', domain: 'www.maxaroma.com', region: 'US', type: 'auto',
    searchUrl: 'https://www.maxaroma.com/search?q={q}' },
  { id: 'perfumania', name: 'Perfumania', domain: 'perfumania.com', region: 'US', type: 'auto' },

  // ── 미국: ScentSift 수록 할인몰 ──
  { id: 'perfumebox', name: 'Perfume Box', domain: 'perfumebox.com', region: 'US', type: 'auto' },
  { id: 'beautyhouse', name: 'Beautyhouse', domain: 'beautyhouse.com', region: 'US', type: 'auto' },
  { id: 'emnt', name: 'EMNT Scents', domain: 'emntscents.com', region: 'US', type: 'auto' },
  { id: 'aura', name: 'Aura Fragrance', domain: 'www.aurafragrance.com', region: 'US', type: 'auto' },
  { id: 'microperfumes', name: 'MicroPerfumes', domain: 'microperfumes.com', region: 'US', type: 'auto' },
  { id: 'labelle', name: 'La Belle Perfumes', domain: 'labelleperfumes.com', region: 'US', type: 'auto' },
  { id: 'venba', name: 'Venba Fragrance', domain: 'www.venbafragrance.com', region: 'US', type: 'auto' },
  { id: 'olfactory', name: 'Olfactory Factory', domain: 'www.olfactoryfactoryllc.com', region: 'US', type: 'auto' },
  { id: 'arvella', name: 'Arvella', domain: 'arvellafragrance.com', region: 'US', type: 'auto' },
  { id: 'ministry', name: 'Ministry of Scent', domain: 'ministryofscent.com', region: 'US', type: 'auto' },
  // ?q= 는 무시되고 아무 상품이나 나옴 → ?term= 이 실제 검색어 (2026-10 확인)
  { id: 'luckyscent', name: 'Luckyscent', domain: 'www.luckyscent.com', region: 'US', type: 'html',
    searchUrl: 'https://www.luckyscent.com/search?term={q}' },
  { id: 'bestbrands', name: 'Best Brands Perfume', domain: 'bestbrandsperfume.com', region: 'US', type: 'auto',
    searchUrl: 'https://bestbrandsperfume.com/?s={q}&post_type=product' },
  { id: 'fragranceoutlet', name: 'Fragrance Outlet', domain: 'www.fragranceoutlet.com', region: 'US', type: 'auto' },
  { id: 'fragranceshopcom', name: 'FragranceShop.com', domain: 'www.fragranceshop.com', region: 'US', type: 'auto' },
  { id: 'beautyencounter', name: 'Beauty Encounter', domain: 'www.beautyencounter.com', region: 'US', type: 'auto' },

  // ── 캐나다 ──
  { id: 'fragflex', name: 'Fragflex', domain: 'fragflex.com', region: 'CA', type: 'shopify' },
  { id: 'fragrancebuy', name: 'FragranceBuy', domain: 'fragrancebuy.ca', region: 'CA', type: 'auto' },

  // ── 영국 ──
  { id: 'perfumeclick', name: 'Perfume Click', domain: 'www.perfume-click.co.uk', region: 'UK', type: 'auto' },
  // 2026-10 기준 사이트 점검 중(자매몰 allbeauty로 안내) → 기본 꺼짐. 재오픈하면 설정에서 켜면 됨
  { id: 'fragrancedirect', name: 'Fragrance Direct', domain: 'www.fragrancedirect.co.uk', region: 'UK', type: 'html', defaultOff: true,
    searchUrl: 'https://www.fragrancedirect.co.uk/search?q={q}' },
  // 2026-10 Shopify 로 바뀜 (예전 /gb/en/search 주소는 404)
  { id: 'allbeauty', name: 'allbeauty', domain: 'allbeauty.com', region: 'UK', type: 'shopify' },
  { id: 'notino', name: 'Notino UK', domain: 'www.notino.co.uk', region: 'UK', type: 'html',
    searchUrl: 'https://www.notino.co.uk/search.asp?exps={q}' },
  { id: 'escentual', name: 'Escentual', domain: 'www.escentual.com', region: 'UK', type: 'html',
    searchUrl: 'https://www.escentual.com/search/?q={q}' },
  { id: 'fragranceshopuk', name: 'The Fragrance Shop', domain: 'www.thefragranceshop.co.uk', region: 'UK', type: 'auto' },
  { id: 'perfumeshopuk', name: 'The Perfume Shop', domain: 'www.theperfumeshop.com', region: 'UK', type: 'html',
    searchUrl: 'https://www.theperfumeshop.com/search?query={q}' },  // ?text= 는 빈 결과
];

export function defaultSearchUrl(store) {
  return store.searchUrl || `https://${store.domain}/search?q={q}&type=product`;
}
