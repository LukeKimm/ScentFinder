-- 재입고 알림 서버 DB (Cloudflare D1)
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  data TEXT NOT NULL,          -- 알림 정보 (JSON)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS watches_url ON watches(url);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,          -- tg_chat: 텔레그램 대화 / last_run: 마지막 확인 기록
  v TEXT NOT NULL
);
