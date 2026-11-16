-- 旧 API のいいね操作を停止してから一度だけ実行する。旧テーブルは削除しない。
-- 依頼または成果へのいいね（いずれか一方のみ指定）
CREATE TABLE IF NOT EXISTS likes (
  request_id BIGINT UNSIGNED NULL,
  assignment_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  CONSTRAINT chk_likes_target CHECK ((request_id IS NOT NULL) <> (assignment_id IS NOT NULL)),
  UNIQUE KEY uq_likes_request_user (request_id, user_id),
  UNIQUE KEY uq_likes_assignment_user (assignment_id, user_id),
  KEY idx_likes_user (user_id),
  CONSTRAINT fk_unified_likes_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_unified_likes_assignment FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
  CONSTRAINT fk_unified_likes_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO likes (request_id, user_id, created_at)
SELECT request_id, user_id, created_at FROM request_supports;
INSERT IGNORE INTO likes (assignment_id, user_id, created_at)
SELECT assignment_id, user_id, created_at FROM assignment_likes;
