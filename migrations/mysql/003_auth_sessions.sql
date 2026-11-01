CREATE TABLE IF NOT EXISTS auth_session (
  jti CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  KEY auth_session_user_expiry_idx (user_id, expires_at),
  CONSTRAINT auth_session_user_fk FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE,
  CONSTRAINT auth_session_expires_positive CHECK (expires_at > 0),
  CONSTRAINT auth_session_revoked_positive CHECK (revoked_at IS NULL OR revoked_at > 0),
  CONSTRAINT auth_session_created_positive CHECK (created_at > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
