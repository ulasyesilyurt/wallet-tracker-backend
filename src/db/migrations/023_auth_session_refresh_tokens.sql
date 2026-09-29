ALTER TABLE auth_sessions
  ADD COLUMN refresh_token_digest BYTEA,
  ADD COLUMN refresh_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT auth_sessions_refresh_pair CHECK (
    (refresh_token_digest IS NULL) = (refresh_expires_at IS NULL)
  ),
  ADD CONSTRAINT auth_sessions_refresh_digest_length CHECK (
    refresh_token_digest IS NULL OR OCTET_LENGTH(refresh_token_digest) = 32
  );

CREATE UNIQUE INDEX idx_auth_sessions_refresh_token_digest
  ON auth_sessions (refresh_token_digest)
  WHERE refresh_token_digest IS NOT NULL;
