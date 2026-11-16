-- 旧 API のいいね操作を停止してから一度だけ実行する。旧テーブルは削除しない。
-- 依頼または成果へのいいね（いずれか一方のみ指定）
CREATE TABLE IF NOT EXISTS likes (
  request_id INTEGER REFERENCES requests (id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES assignments (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  CHECK ((request_id IS NOT NULL) <> (assignment_id IS NOT NULL)),
  UNIQUE (request_id, user_id),
  UNIQUE (assignment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes (user_id);

INSERT OR IGNORE INTO likes (request_id, user_id, created_at)
SELECT request_id, user_id, created_at FROM request_supports;
INSERT OR IGNORE INTO likes (assignment_id, user_id, created_at)
SELECT assignment_id, user_id, created_at FROM assignment_likes;
