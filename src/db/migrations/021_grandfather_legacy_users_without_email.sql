-- Legacy accounts may predate email/password sign-in and cannot receive a code.
-- New registrations always require an email and remain unverified until confirmed.
UPDATE app_users
SET email_verified_at = NOW()
WHERE email IS NULL AND email_verified_at IS NULL;
