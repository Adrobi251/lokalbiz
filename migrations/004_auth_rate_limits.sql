CREATE TABLE auth_rate_limit_bucket (
  bucket_hash TEXT PRIMARY KEY CHECK (length(bucket_hash) = 64),
  window_started_at INTEGER NOT NULL CHECK (window_started_at > 0),
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > window_started_at)
) STRICT;
CREATE INDEX auth_rate_limit_bucket_expiry_idx ON auth_rate_limit_bucket (expires_at);
