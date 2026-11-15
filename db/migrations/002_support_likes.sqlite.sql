-- Existing Phase 1 DB: run this migration once. Do not reimport the full schema.
-- Phase 2: 依頼への応援と承認済み成果へのいいね
CREATE TABLE IF NOT EXISTS request_supports (
  request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_request_supports_user ON request_supports (user_id);

CREATE TABLE IF NOT EXISTS assignment_likes (
  assignment_id INTEGER NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (assignment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_likes_user ON assignment_likes (user_id);
