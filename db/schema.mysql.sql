-- OSM Mappers Guild — MySQL schema (Phase 1 MVP)
-- 文字コードは utf8mb4 を想定。作成したDBに対してこのSQLを実行してください。

CREATE TABLE IF NOT EXISTS users (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  osm_user_id  BIGINT NOT NULL,
  display_name VARCHAR(191) NOT NULL,
  created_at   DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_osm_user_id (osm_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS requests (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  title        VARCHAR(120) NOT NULL,
  description  TEXT NOT NULL,
  category     VARCHAR(40) NOT NULL,
  reward_text  VARCHAR(300) NULL,
  area_geojson TEXT NOT NULL,
  status       VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at   DATETIME NOT NULL,
  updated_at   DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_requests_status (status),
  KEY idx_requests_user (user_id),
  CONSTRAINT fk_requests_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assignments (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  status     VARCHAR(32) NOT NULL DEFAULT 'joined',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assignments_pair (request_id, user_id),
  KEY idx_assignments_request (request_id),
  CONSTRAINT fk_assignments_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assignment_changesets (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  assignment_id BIGINT UNSIGNED NOT NULL,
  changeset_id  BIGINT NOT NULL,
  created_at    DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assignment_changeset (assignment_id, changeset_id),
  CONSTRAINT fk_changesets_assignment FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS review_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id    BIGINT UNSIGNED NOT NULL,
  assignment_id BIGINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  event_type    VARCHAR(32) NOT NULL,
  comment       TEXT NULL,
  created_at    DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_events_request (request_id, created_at),
  CONSTRAINT fk_events_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_events_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
