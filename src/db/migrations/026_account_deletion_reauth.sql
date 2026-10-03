CREATE TABLE account_deletion_reauth_challenges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL DEFAULT 'account_delete' CHECK (operation = 'account_delete'),
  method TEXT NOT NULL CHECK (method IN ('password', 'apple', 'google')),
  nonce_digest BYTEA,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT account_deletion_reauth_nonce_check CHECK (
    (method = 'password' AND nonce_digest IS NULL) OR
    (method IN ('apple', 'google') AND nonce_digest IS NOT NULL
      AND OCTET_LENGTH(nonce_digest) = 32)
  )
);

CREATE UNIQUE INDEX account_deletion_reauth_one_open_challenge
  ON account_deletion_reauth_challenges (session_id, operation)
  WHERE consumed_at IS NULL;
CREATE INDEX account_deletion_reauth_challenges_user_created
  ON account_deletion_reauth_challenges (user_id, created_at DESC);
CREATE INDEX account_deletion_reauth_challenges_expiry
  ON account_deletion_reauth_challenges (expires_at);

CREATE TABLE account_deletion_authorizations (
  authorization_digest BYTEA PRIMARY KEY CHECK (OCTET_LENGTH(authorization_digest) = 32),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL DEFAULT 'account_delete' CHECK (operation = 'account_delete'),
  verified_method TEXT NOT NULL CHECK (verified_method IN ('password', 'apple', 'google')),
  verified_provider_subject TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT account_deletion_authorizations_subject_check CHECK (
    (verified_method = 'password' AND verified_provider_subject IS NULL) OR
    (verified_method IN ('apple', 'google') AND
      verified_provider_subject IS NOT NULL AND verified_provider_subject <> '')
  )
);

CREATE UNIQUE INDEX account_deletion_authorizations_one_open_grant
  ON account_deletion_authorizations (session_id, operation)
  WHERE consumed_at IS NULL;
CREATE INDEX account_deletion_authorizations_expiry
  ON account_deletion_authorizations (expires_at);
