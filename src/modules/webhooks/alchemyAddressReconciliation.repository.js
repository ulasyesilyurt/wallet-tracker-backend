import { isSupportedChainId } from '../chains/chains.config.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export async function markAlchemyAddressPairsDirty(client, pairs) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A transaction client is required to mark Alchemy addresses dirty');
  }

  const uniquePairs = new Map();

  for (const pair of pairs) {
    const chainId = pair.chainId;
    const address = typeof pair.address === 'string' ? pair.address.trim().toLowerCase() : '';

    if (!isSupportedChainId(chainId) || !ADDRESS_PATTERN.test(address)) {
      throw new TypeError('Invalid Alchemy chain/address pair');
    }

    uniquePairs.set(`${chainId}:${address}`, { chainId, address });
  }

  for (const { chainId, address } of [...uniquePairs.values()].sort((a, b) =>
    a.chainId.localeCompare(b.chainId) || a.address.localeCompare(b.address)
  )) {
    await client.query(
      `
        INSERT INTO alchemy_address_reconciliation (
          chain_id, normalized_address
        ) VALUES ($1, $2)
        ON CONFLICT (chain_id, normalized_address)
        DO UPDATE SET
          generation = alchemy_address_reconciliation.generation + 1,
          attempt_count = 0,
          next_attempt_at = NOW(),
          claim_token = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          updated_at = NOW()
      `,
      [chainId, address]
    );
  }
}
