CREATE TABLE IF NOT EXISTS app_user (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
  password_hash VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT app_user_email_valid CHECK (
    CHAR_LENGTH(email) BETWEEN 3 AND 254 AND email = LOWER(TRIM(email))
  ),
  CONSTRAINT app_user_password_hash_length CHECK (CHAR_LENGTH(password_hash) BETWEEN 1 AND 256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
