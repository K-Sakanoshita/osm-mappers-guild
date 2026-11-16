-- Phase 1 hardening: no-edit reports and moderation (run AFTER 003_unify_likes)
ALTER TABLE assignments ADD COLUMN report_kind VARCHAR(20) NOT NULL DEFAULT 'edit';
ALTER TABLE requests ADD COLUMN is_hidden TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE moderation_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  reporter_user_id BIGINT UNSIGNED NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL,
  reviewed_at DATETIME NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_moderation_request_reporter (request_id, reporter_user_id),
  KEY idx_moderation_status (status, created_at),
  CONSTRAINT fk_mod_report_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_mod_report_reporter FOREIGN KEY (reporter_user_id) REFERENCES users (id),
  CONSTRAINT fk_mod_report_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE moderation_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(30) NOT NULL,
  reason TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  KEY idx_moderation_actions_request (request_id, created_at),
  CONSTRAINT fk_mod_action_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_mod_action_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Repair historical status: mark completed only if every participant is approved.
-- Preserve withdrawn requests and their state.
UPDATE requests r
LEFT JOIN (
  SELECT request_id,
         COUNT(*) AS total,
         SUM(status = 'reported') AS awaiting,
         SUM(status = 'changes_requested') AS revisions,
         SUM(status = 'joined') AS working,
         SUM(status = 'approved') AS approved
    FROM assignments GROUP BY request_id
) a ON a.request_id = r.id
SET r.status = CASE
  WHEN COALESCE(a.total, 0) = 0 THEN 'open'
  WHEN COALESCE(a.awaiting, 0) > 0 THEN 'awaiting_review'
  WHEN COALESCE(a.revisions, 0) > 0 THEN 'changes_requested'
  WHEN COALESCE(a.working, 0) > 0 THEN 'in_progress'
  WHEN a.approved = a.total THEN 'completed'
  ELSE 'in_progress'
END
WHERE r.status <> 'withdrawn';
