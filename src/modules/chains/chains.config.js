export const ETHEREUM_MAINNET_CHAIN_ID = 'ethereum-mainnet';
export const BASE_MAINNET_CHAIN_ID = 'base-mainnet';

export const SUPPORTED_CHAIN_IDS = [
  ETHEREUM_MAINNET_CHAIN_ID,
  BASE_MAINNET_CHAIN_ID
];

const CHAIN_CONFIGS = [
  {
    chainId: ETHEREUM_MAINNET_CHAIN_ID,
    displayName: 'Ethereum',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerTxBaseUrl: 'https://etherscan.io/tx/',
    alchemyWebhookNetworkValues: ['ETH_MAINNET', 'ETHEREUM_MAINNET', 'ethereum-mainnet'],
    alchemyAddressActivityWebhookEnvVar: 'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_ETHEREUM_MAINNET',
    legacyAlchemyAddressActivityWebhookEnvVar: 'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID',
    zerionChainId: 'ethereum'
  },
  {
    chainId: BASE_MAINNET_CHAIN_ID,
    displayName: 'Base',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerTxBaseUrl: 'https://basescan.org/tx/',
    alchemyWebhookNetworkValues: ['BASE_MAINNET', 'base-mainnet', 'BASE', 'base'],
    alchemyAddressActivityWebhookEnvVar: 'ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_ID_BASE_MAINNET',
    zerionChainId: 'base'
  }
];

const CHAIN_CONFIG_BY_ID = new Map(CHAIN_CONFIGS.map((chainConfig) => [chainConfig.chainId, chainConfig]));
const CHAIN_ID_BY_ALCHEMY_NETWORK = new Map(
  CHAIN_CONFIGS.flatMap((chainConfig) =>
    chainConfig.alchemyWebhookNetworkValues.map((networkValue) => [networkValue, chainConfig.chainId])
  )
);

export function getSupportedChainConfigs() {
  return [...CHAIN_CONFIGS];
}

export function getChainConfigById(chainId) {
  return CHAIN_CONFIG_BY_ID.get(chainId) ?? null;
}

export function isSupportedChainId(chainId) {
  return CHAIN_CONFIG_BY_ID.has(chainId);
}

export function resolveChainIdFromAlchemyWebhookNetwork(network) {
  if (!network) {
    return ETHEREUM_MAINNET_CHAIN_ID;
  }

  return CHAIN_ID_BY_ALCHEMY_NETWORK.get(network) ?? null;
}

export function getExplorerTxBaseUrl(chainId) {
  return getChainConfigById(chainId)?.explorerTxBaseUrl ?? null;
}
