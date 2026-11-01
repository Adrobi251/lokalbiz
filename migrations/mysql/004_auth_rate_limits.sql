CREATE TABLE IF NOT EXISTS auth_rate_limit_bucket (
  bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  window_started_at BIGINT NOT NULL,
  request_count BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  KEY auth_rate_limit_bucket_expiry_idx (expires_at),
  CONSTRAINT auth_rate_limit_hash_length CHECK (CHAR_LENGTH(bucket_hash) = 64),
  CONSTRAINT auth_rate_limit_window_positive CHECK (window_started_at > 0),
  CONSTRAINT auth_rate_limit_count_positive CHECK (request_count > 0),
  CONSTRAINT auth_rate_limit_expiry_valid CHECK (expires_at > window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
