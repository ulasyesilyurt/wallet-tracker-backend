CREATE TABLE auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_identities_provider_subject_key UNIQUE (provider, provider_subject),
  CONSTRAINT auth_identities_user_provider_key UNIQUE (user_id, provider)
);

CREATE INDEX idx_auth_identities_user_id ON auth_identities (user_id);
