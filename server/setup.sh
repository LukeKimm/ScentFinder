#!/bin/bash
# 향수 최저가 — 재입고 알림 서버 설치 (Mac 터미널에서 실행)
#
#   cd ~/ScentFinder/server
#   ./setup.sh
#
# 운영자가 한 번 실행합니다. 사용자는 이 단계 없이 확장 화면에서 텔레그램·이메일을 직접 등록해요.
#
# 하는 일
#   1) Cloudflare 로그인 (브라우저가 열림)
#   2) 데이터베이스(D1) 만들기 + 표 만들기
#   3) 서버 올리기 (1분마다 재고 확인 예약 포함)
#   4) 텔레그램 봇 토큰·Resend 키를 서버 비밀값으로 저장
#   5) 서버 주소를 확장 프로그램 설정(extension/alerts-config.js)에 기록
#
# 다시 실행해도 됩니다. 이미 있는 데이터베이스는 그대로 쓰고, 입력을 비워 두면 그 값은 바꾸지 않아요.
# 도메인을 산 뒤 메일 보내는 주소를 바꿀 때:  ./setup.sh --email-from
set -eo pipefail
cd "$(dirname "$0")"
DB_NAME="scentfinder-alerts"
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
put_secret() {   # 이름, 안내 문구, 숨김 입력 여부
  local val
  if [ "$3" = "hidden" ]; then read -r -s -p "$2: " val; echo; else read -r -p "$2: " val; fi
  if [ -n "$val" ]; then printf '%s' "$val" | $W secret put "$1" >/dev/null && echo "  → 저장 완료"; else echo "  → 건너뜀 (기존 값 유지)"; fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  exit 1
fi

step "필요한 도구 설치 (wrangler)"
npm install --no-audit --no-fund --silent
W="npx --no-install wrangler"

step "Cloudflare 로그인"
if ! $W whoami 2>/dev/null | grep -qi "logged in"; then
  echo "브라우저가 열리면 Cloudflare 에 로그인(또는 무료 가입)하고 'Allow' 를 눌러 주세요."
  $W login
fi

if [ "$1" = "--email-from" ]; then
  step "메일 보내는 주소 (도메인 인증 후)"
  echo "Resend 에서 도메인 인증을 마친 뒤, 보내는 주소를 입력하세요. 예: 향수 최저가 <alert@내도메인.com>"
  put_secret EMAIL_FROM "보내는 주소"
  echo "이제 모든 사용자가 자기 메일 주소를 등록할 수 있어요."
  exit 0
fi

step "데이터베이스 준비"
if grep -q "SET_BY_SETUP" wrangler.toml; then
  ID=$($W d1 list --json 2>/dev/null | python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  print(next((x.get('uuid') or x.get('id') for x in d if x.get('name')=='$DB_NAME'), ''))
except Exception: print('')")
  if [ -z "$ID" ]; then
    OUT=$($W d1 create "$DB_NAME" 2>&1) || { echo "$OUT"; exit 1; }
    ID=$(echo "$OUT" | grep -oE "$UUID_RE" | head -1)
  fi
  if [ -z "$ID" ]; then echo "데이터베이스 ID 를 찾지 못했습니다. 위 메시지를 확인해 주세요."; exit 1; fi
  sed -i '' "s/SET_BY_SETUP/$ID/" wrangler.toml
  echo "데이터베이스: $DB_NAME ($ID)"
fi
$W d1 execute "$DB_NAME" --remote --file schema.sql --yes >/dev/null
echo "표 준비 완료"

step "서버 올리기"
# 처음이면 workers.dev 주소 이름을 물어볼 수 있어서, 화면에 그대로 보여주면서(script) 기록만 남김
script -q .deploy.log $W deploy
URL=$(grep -aoE 'https://[a-zA-Z0-9.-]+\.workers\.dev' .deploy.log | head -1)



step "텔레그램 봇"
echo "텔레그램 앱에서 @BotFather → /newbot 으로 봇을 만들고 받은 토큰을 붙여넣으세요. (입력은 화면에 보이지 않아요)"
put_secret TELEGRAM_BOT_TOKEN "텔레그램 봇 토큰" hidden

step "이메일 발송 (Resend)"
echo "resend.com 에서 무료 가입 → API Keys → Create API Key 로 만든 키를 붙여넣으세요. (입력은 화면에 보이지 않아요)"
echo "도메인을 사기 전에는 Resend 에 가입한 메일 주소로만 보낼 수 있어요. (나중에 ./setup.sh --email-from)"
put_secret RESEND_API_KEY "Resend API 키" hidden

step "확장 프로그램에 서버 주소 기록"
if [ -n "$URL" ]; then
  printf '%s\n' "// 재입고 알림 서버 주소" "// 운영자가 server/setup.sh 를 실행하면 자동으로 채워집니다. 사용자는 손댈 필요 없음." "export const ALERT_SERVER = '$URL';" > ../extension/alerts-config.js
  echo "extension/alerts-config.js ← $URL"
else
  echo "서버 주소를 찾지 못했어요. 위 deploy 출력의 https://….workers.dev 주소를 extension/alerts-config.js 에 직접 넣어 주세요."
fi

printf '\n\033[1m✅ 설치 완료\033[0m\n'
echo "1) Xcode 에서 ▶ 를 눌러 확장을 다시 빌드하고, Safari 를 ⌘Q 로 종료했다가 다시 여세요."
echo "2) 확장 검색 화면 → '재입고 알림' → '텔레그램 연결' → 텔레그램에서 '시작'"
echo "3) '테스트 알림 보내기'로 확인"
