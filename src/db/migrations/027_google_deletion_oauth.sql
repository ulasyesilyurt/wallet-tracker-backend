ALTER TABLE account_deletion_reauth_challenges
  ADD COLUMN google_state_digest BYTEA,
  ADD COLUMN google_pkce_verifier TEXT,
  ADD COLUMN google_oauth_client_id TEXT,
  ADD COLUMN google_oauth_redirect_uri TEXT,
  ADD COLUMN google_callback_status TEXT,
  ADD COLUMN google_verified_subject TEXT,
  ADD COLUMN google_callback_completed_at TIMESTAMPTZ;

ALTER TABLE account_deletion_reauth_challenges
  ADD CONSTRAINT account_deletion_google_oauth_check CHECK (
    (method <> 'google' AND google_state_digest IS NULL
      AND google_pkce_verifier IS NULL AND google_oauth_client_id IS NULL
      AND google_oauth_redirect_uri IS NULL AND google_callback_status IS NULL
      AND google_verified_subject IS NULL AND google_callback_completed_at IS NULL)
    OR
    (method = 'google' AND google_state_digest IS NOT NULL
      AND OCTET_LENGTH(google_state_digest) = 32
      AND google_oauth_client_id IS NOT NULL AND google_oauth_client_id <> ''
      AND google_oauth_redirect_uri IS NOT NULL AND google_oauth_redirect_uri <> ''
      AND google_callback_status IS NOT NULL
      AND google_callback_status IN ('pending', 'exchanging', 'verified', 'failed')
      AND (
        (google_callback_status IN ('pending', 'exchanging')
          AND google_pkce_verifier IS NOT NULL
          AND LENGTH(google_pkce_verifier) BETWEEN 43 AND 128
          AND google_verified_subject IS NULL AND google_callback_completed_at IS NULL)
        OR
        (google_callback_status = 'verified' AND google_pkce_verifier IS NULL
          AND google_verified_subject IS NOT NULL AND google_verified_subject <> ''
          AND google_callback_completed_at IS NOT NULL)
        OR
        (google_callback_status = 'failed' AND google_pkce_verifier IS NULL
          AND google_verified_subject IS NULL AND google_callback_completed_at IS NOT NULL)
      ))
  );

CREATE UNIQUE INDEX account_deletion_google_state_digest_unique
  ON account_deletion_reauth_challenges (google_state_digest)
  WHERE google_state_digest IS NOT NULL;
