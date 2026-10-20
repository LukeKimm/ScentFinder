# 향수 최저가 · Scent Price Finder

미국·영국·캐나다 해외 향수 할인몰 30곳을 한 번에 검색해서 원화 기준 최저가 순으로 보여주는 Safari 확장입니다. Mac과 iPhone Safari에서 모두 동작합니다.

A Safari web extension (macOS + iOS) that searches 30 US, UK and Canadian fragrance discounters at once and sorts results by the lowest price in KRW.

## 기능

- 30개 쇼핑몰 동시 검색 (Shopify·WooCommerce 몰은 자동 인식, 사이트 직접 추가 가능)
- 종류 필터: 정품 박스 / 테스터 / 언박스 / 미니·샘플·디캔트 / 세트, 품절 포함 여부
- 용량 선택, 원화 최저가·ml당 가격·사이트별 정렬
- 자동 환율(open.er-api.com) 또는 직접 입력
- 한국어 / English 화면 전환
- 봇 차단·자바스크립트 렌더링 사이트는 숨은 탭으로 열어서 읽기 (Shopify는 용량별 가격까지)
- 방문한 사이트의 쿠키 재사용 옵션
- 그래도 못 읽은 사이트는 버튼 하나로 검색 결과 탭 열기

## 빠른 설치

Mac에 App Store에서 [Xcode](https://apps.apple.com/app/xcode/id497799835)를 설치하고 Xcode › Settings › Accounts에 Apple ID를 등록한 뒤:

```
git clone https://github.com/LukeKimm/ScentFinder.git
cd ScentFinder
chmod +x build.sh
./build.sh
```

Xcode가 열리면 4개 타깃의 **Signing & Capabilities › Team**을 지정하고 ▶ 실행 → Safari 설정에서 확장을 켜고 웹사이트 접근을 허용합니다. 업데이트는 `git pull`.

- [설치안내.md](설치안내.md) — Xcode 설치부터 Mac·아이폰 설치, 업데이트까지 단계별 안내
- [docs/설치-출시-가이드.md](docs/설치-출시-가이드.md) — Xcode 설치 & 앱스토어 출시 상세 가이드

## 구조

| 경로 | 역할 |
|---|---|
| `extension/manifest.json` | 확장 설정 (Manifest V3) |
| `extension/stores.js` | 검색 대상 사이트 목록 |
| `extension/adapters.js` | Shopify / WooCommerce / 페이지 분석 방식별 검색 |
| `extension/tabs.js` | 막힌 사이트를 숨은 탭으로 열어 읽기 |
| `extension/classify.js` | 용량·종류·관련도 판별 |
| `extension/i18n.js`, `extension/_locales` | 한국어/영어 문구 |
| `extension/app.*` | 검색 결과 화면 |
| `extension/popup.*` | 툴바 팝업 |
| `build.sh` | Xcode 프로젝트 생성 (`safari-web-extension-converter`) |

## 참고

- 가격은 상품가 기준이며 배송비·관부가세는 포함하지 않습니다.
- 검색어와 설정은 기기 안에만 저장되고, 외부 서버로 보내지 않습니다.
