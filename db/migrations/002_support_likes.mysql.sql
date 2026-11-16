-- Existing Phase 1 DB: run this migration once. Do not reimport the full schema.
-- Phase 2: 依頼への応援と承認済み成果へのいいね
CREATE TABLE IF NOT EXISTS request_supports (
  request_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (request_id, user_id),
  KEY idx_request_supports_user (user_id),
  CONSTRAINT fk_supports_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_supports_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assignment_likes (
  assignment_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (assignment_id, user_id),
  KEY idx_assignment_likes_user (user_id),
  CONSTRAINT fk_likes_assignment FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
  CONSTRAINT fk_likes_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
