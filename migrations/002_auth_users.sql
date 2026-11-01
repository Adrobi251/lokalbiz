CREATE TABLE app_user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(trim(email))),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL
) STRICT;
