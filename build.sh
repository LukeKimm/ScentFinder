#!/bin/bash
# 향수 최저가 — Safari 확장(Mac + iPhone) Xcode 프로젝트 생성
set -e
cd "$(dirname "$0")"

# git pull 할 때 새 파일을 Xcode 프로젝트에 자동 등록하도록 훅 연결 (.githooks/post-merge)
[ -d .git ] && git config core.hooksPath .githooks || true

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Xcode가 필요합니다. App Store에서 Xcode 설치 후 한 번 실행해 주세요."
  exit 1
fi

if [ -d "xcode/ScentFinder" ]; then
  echo "이미 xcode/ScentFinder 프로젝트가 있습니다."
  echo "기존 파일만 고쳤다면 Xcode에서 다시 실행(⌘R)하면 반영됩니다."
  echo "새 파일이 추가된 버전이라면: rm -rf xcode 후 ./build.sh 를 다시 실행하고 서명을 다시 설정하세요."
  open "xcode/ScentFinder/ScentFinder.xcodeproj"
  exit 0
fi

BUNDLE_ID="${1:-com.$(whoami | tr -cd '[:alnum:]').scentfinder}"

xcrun safari-web-extension-converter ./extension \
  --project-location ./xcode \
  --app-name "ScentFinder" \
  --bundle-identifier "$BUNDLE_ID" \
  --swift \
  --no-prompt \
  --no-open

echo ""
echo "✅ 프로젝트 생성 완료 (번들 ID: $BUNDLE_ID)"
echo "   Xcode에서 서명(Team) 설정 후 실행하세요. 자세한 순서는 설치안내.md 참고."
open "xcode/ScentFinder/ScentFinder.xcodeproj"
