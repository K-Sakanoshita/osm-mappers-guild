-- Phase 1 hardening: no-edit reports and moderation (run AFTER 003_unify_likes)
ALTER TABLE assignments ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE requests ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;

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

UPDATE requests SET status = CASE
  WHEN NOT EXISTS (SELECT 1 FROM assignments a WHERE a.request_id = requests.id) THEN 'open'
  WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.request_id = requests.id AND a.status = 'reported') THEN 'awaiting_review'
  WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.request_id = requests.id AND a.status = 'changes_requested') THEN 'changes_requested'
  WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.request_id = requests.id AND a.status = 'joined') THEN 'in_progress'
  WHEN NOT EXISTS (SELECT 1 FROM assignments a WHERE a.request_id = requests.id AND a.status <> 'approved') THEN 'completed'
  ELSE 'in_progress'
END WHERE status <> 'withdrawn';
