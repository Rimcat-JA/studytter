CREATE INDEX IF NOT EXISTS interactions_post_time_idx ON interactions(post_id,created_at);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  answer_index INTEGER,
  correct INTEGER NOT NULL CHECK(correct IN (0,1)),
  created_at INTEGER NOT NULL,
  next_review_at INTEGER NOT NULL,
  UNIQUE(post_id,session_key)
);
CREATE INDEX IF NOT EXISTS quiz_attempts_post_time_idx ON quiz_attempts(post_id,created_at);
INSERT OR IGNORE INTO __learnstream_migrations(id,applied_at) VALUES('0001_quiz_attempts',unixepoch()*1000);
