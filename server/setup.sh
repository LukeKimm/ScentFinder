#!/bin/bash
# 향수 최저가 — 재입고 알림 서버 설치 (Mac 터미널에서 실행)
#
#   cd ~/ScentFinder/server
#   ./setup.sh
#
# 하는 일
#   1) Cloudflare 로그인 (브라우저가 열림)
#   2) 데이터베이스(D1) 만들기 + 표 만들기
#   3) 서버 올리기 (1분마다 재고 확인 예약 포함)
#   4) 접속 키 만들기, 텔레그램 봇 토큰·Resend 키·메일 주소 입력 받아 서버 비밀값으로 저장
#   5) 확장에 넣을 "서버 주소"와 "접속 키" 출력
#
# 다시 실행해도 됩니다. 이미 있는 데이터베이스는 그대로 쓰고, 입력을 비워 두면 그 값은 바꾸지 않아요.
set -eo pipefail
cd "$(dirname "$0")"
DB_NAME="scentfinder-alerts"
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

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

step "접속 키"
if [ -f .alerts-key ]; then
  KEY=$(cat .alerts-key)
  echo "기존 접속 키를 그대로 씁니다. (새로 만들려면 server/.alerts-key 를 지우고 다시 실행)"
else
  KEY=$(openssl rand -hex 24)
  echo "$KEY" > .alerts-key
  chmod 600 .alerts-key
fi
printf '%s' "$KEY" | $W secret put API_TOKEN >/dev/null
echo "저장 완료"

put_secret() {   # 이름, 안내 문구, 숨김 입력 여부
  local val
  if [ "$3" = "hidden" ]; then read -r -s -p "$2: " val; echo; else read -r -p "$2: " val; fi
  if [ -n "$val" ]; then printf '%s' "$val" | $W secret put "$1" >/dev/null && echo "  → 저장 완료"; else echo "  → 건너뜀 (기존 값 유지)"; fi
}

step "텔레그램"
echo "텔레그램 앱에서 @BotFather → /newbot 으로 봇을 만들고 받은 토큰을 붙여넣으세요. (입력은 화면에 보이지 않아요)"
put_secret TELEGRAM_BOT_TOKEN "텔레그램 봇 토큰" hidden

step "이메일 (Resend)"
echo "resend.com 에서 무료 가입 → API Keys → Create API Key 로 만든 키를 붙여넣으세요. (입력은 화면에 보이지 않아요)"
put_secret RESEND_API_KEY "Resend API 키" hidden
echo "알림 받을 메일 주소 — Resend 에 가입한 그 메일 주소여야 합니다. (도메인 인증 전에는 그 주소로만 보낼 수 있음)"
put_secret EMAIL_TO "메일 주소"

printf '\n\033[1m✅ 설치 완료\033[0m\n'
echo "확장 프로그램 → 검색 화면 → '재입고 알림' 칸에 아래 두 값을 넣고 '저장하고 연결 확인'을 누르세요."
echo ""
echo "  서버 주소: ${URL:-(위 'deploy' 출력의 https://….workers.dev 주소)}"
echo "  접속 키:   $KEY"
if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$KEY" | pbcopy; echo "  (접속 키는 클립보드에 복사돼 있어요)"; fi
echo ""
echo "그다음 텔레그램에서 내 봇에게 아무 메시지(예: /start)를 보내고, 확장에서 '텔레그램 연결' → '테스트 알림 보내기'를 눌러 확인하세요."
