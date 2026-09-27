-- Keep the collision check and index replacement in one migration transaction.
-- Report only the number of affected groups; account resolution is manual.
LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  collision_groups BIGINT;
BEGIN
  SELECT COUNT(*) INTO collision_groups
  FROM (
    SELECT LOWER(email)
    FROM app_users
    WHERE email IS NOT NULL
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  ) duplicate_emails;

  IF collision_groups > 0 THEN
    RAISE EXCEPTION 'Cannot enforce normalized email uniqueness: % collision group(s) require manual resolution',
      collision_groups
      USING ERRCODE = 'CE001';
  END IF;
END $$;

CREATE UNIQUE INDEX idx_app_users_email_normalized_unique
  ON app_users (LOWER(email))
  WHERE email IS NOT NULL;

DROP INDEX IF EXISTS idx_app_users_email;
