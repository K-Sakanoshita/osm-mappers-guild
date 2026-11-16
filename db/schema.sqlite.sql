-- OSM Mappers Guild — SQLite schema (開発用。本番は schema.mysql.sql を使用)
-- APIのコードは MySQL / SQLite 両対応で、SQLは共通化してある。

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_user_id  INTEGER NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  reward_text  TEXT,
  area_geojson TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  is_hidden    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_user ON requests (user_id);

CREATE TABLE IF NOT EXISTS assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  status     TEXT NOT NULL DEFAULT 'joined',
  report_kind TEXT NOT NULL DEFAULT 'edit',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_request ON assignments (request_id);

CREATE TABLE IF NOT EXISTS assignment_changesets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  changeset_id  INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (assignment_id, changeset_id)
);

CREATE TABLE IF NOT EXISTS review_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  assignment_id INTEGER,
  actor_user_id INTEGER NOT NULL REFERENCES users (id),
  event_type    TEXT NOT NULL,
  comment       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_request ON review_events (request_id, created_at);

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

-- Phase 1 hardening: no-edit reports and moderation (run AFTER 003_unify_likes)



CREATE TABLE moderation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  reporter_user_id INTEGER NOT NULL REFERENCES users (id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by INTEGER REFERENCES users (id),
  UNIQUE (request_id, reporter_user_id)
);
CREATE INDEX idx_moderation_status ON moderation_reports (status, created_at);

CREATE TABLE moderation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  actor_user_id INTEGER NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_moderation_actions_request ON moderation_actions (request_id, created_at);

