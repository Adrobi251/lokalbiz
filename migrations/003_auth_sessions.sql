CREATE TABLE auth_session (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;
CREATE INDEX auth_session_user_expiry_idx ON auth_session (user_id, expires_at);
