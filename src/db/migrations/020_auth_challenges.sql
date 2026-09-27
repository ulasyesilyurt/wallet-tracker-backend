-- Existing accounts keep their current access while new accounts can verify email.
ALTER TABLE app_users ADD COLUMN email_verified_at TIMESTAMPTZ;
UPDATE app_users SET email_verified_at = NOW() WHERE email IS NOT NULL;

CREATE TABLE auth_challenges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  code_digest TEXT NOT NULL CHECK (length(code_digest) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auth_challenges_user_purpose_created
  ON auth_challenges (user_id, purpose, created_at DESC);
CREATE INDEX idx_auth_challenges_expires_at ON auth_challenges (expires_at);
