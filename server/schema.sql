-- 재입고 알림 서버 DB (Cloudflare D1) — 여러 사용자용
-- 사용자: 기기(확장)마다 자동 가입. 접속 키는 해시만 저장
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  tg_chat TEXT,                 -- 텔레그램 대화 ID (연결했을 때)
  tg_name TEXT,
  email TEXT,                   -- 인증 끝난 메일 주소
  email_pending TEXT,           -- 인증 대기 중인 메일 주소
  email_token TEXT,
  email_token_exp INTEGER,
  email_sent_at INTEGER,
  email_sent_day TEXT,
  email_sent_count INTEGER DEFAULT 0,
  lang TEXT DEFAULT 'ko',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_email_token ON users(email_token);
CREATE INDEX IF NOT EXISTS users_tg_chat ON users(tg_chat);

-- 텔레그램 연결 코드 (15분 유효)
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exp INTEGER NOT NULL
);

-- 재입고 알림 (사용자별)
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  data TEXT NOT NULL,           -- 알림 정보 (JSON)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id);
CREATE INDEX IF NOT EXISTS alerts_url ON alerts(url);

-- 기타 (마지막 확인 기록, 봇 정보, 가입 횟수 제한 등)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
