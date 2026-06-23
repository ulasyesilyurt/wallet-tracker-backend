ALTER TABLE wallet_events
  ADD COLUMN IF NOT EXISTS token_contract_address TEXT;

UPDATE wallet_events
SET token_contract_address = lower(raw_payload->>'contractAddress')
WHERE event_type = 'token_transfer'
  AND token_contract_address IS NULL
  AND raw_payload ? 'contractAddress'
  AND raw_payload->>'contractAddress' <> '';
