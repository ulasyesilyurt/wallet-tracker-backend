import {
  BASE_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID
} from '../chains/chains.config.js';
import { buildAsciiSkeleton } from './tokenIdentity.utils.js';

const PROTECTED_TOKEN_DEFINITIONS = [
  {
    assetId: 'ETH',
    labels: ['ETH', 'Ethereum'],
    canonicalContractsByChain: {}
  },
  {
    assetId: 'WETH',
    labels: ['WETH', 'Wrapped Ether'],
    canonicalContractsByChain: {
      [ETHEREUM_MAINNET_CHAIN_ID]: ['0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
      [BASE_MAINNET_CHAIN_ID]: ['0x4200000000000000000000000000000000000006']
    }
  },
  {
    assetId: 'USDC',
    labels: ['USDC', 'USD Coin'],
    canonicalContractsByChain: {
      [ETHEREUM_MAINNET_CHAIN_ID]: ['0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
      [BASE_MAINNET_CHAIN_ID]: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']
    }
  },
  {
    assetId: 'USDT',
    labels: ['USDT', 'Tether USD', 'Tether'],
    canonicalContractsByChain: {
      [ETHEREUM_MAINNET_CHAIN_ID]: ['0xdAC17F958D2ee523a2206206994597C13D831ec7'],
      [BASE_MAINNET_CHAIN_ID]: ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2']
    }
  },
  {
    assetId: 'DAI',
    labels: ['DAI', 'Dai Stablecoin'],
    canonicalContractsByChain: {
      [ETHEREUM_MAINNET_CHAIN_ID]: ['0x6B175474E89094C44Da98b954EedeAC495271d0F'],
      [BASE_MAINNET_CHAIN_ID]: ['0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb']
    }
  }
];

const PROTECTED_TOKEN_DEFINITION_BY_ID = new Map(
  PROTECTED_TOKEN_DEFINITIONS.map((definition) => [definition.assetId, definition])
);

function normalizeContractList(contractAddresses = []) {
  return new Set(
    contractAddresses
      .map((contractAddress) => contractAddress.toLowerCase())
  );
}

export function listProtectedTokenDefinitions() {
  return PROTECTED_TOKEN_DEFINITIONS.map((definition) => ({
    ...definition,
    labels: [...definition.labels],
    canonicalContractsByChain: Object.fromEntries(
      Object.entries(definition.canonicalContractsByChain).map(([chainId, contractAddresses]) => [
        chainId,
        [...contractAddresses]
      ])
    )
  }));
}

export function getProtectedTokenDefinition(assetId) {
  const definition = PROTECTED_TOKEN_DEFINITION_BY_ID.get(assetId) ?? null;

  if (!definition) {
    return null;
  }

  return {
    ...definition,
    labels: [...definition.labels],
    canonicalContractsByChain: Object.fromEntries(
      Object.entries(definition.canonicalContractsByChain).map(([chainId, contractAddresses]) => [
        chainId,
        [...contractAddresses]
      ])
    )
  };
}

export function getProtectedTokenSkeletons(assetIds) {
  const skeletons = new Set();

  for (const assetId of assetIds) {
    const definition = PROTECTED_TOKEN_DEFINITION_BY_ID.get(assetId);

    if (!definition) {
      continue;
    }

    for (const label of definition.labels) {
      const skeleton = buildAsciiSkeleton(label);

      if (skeleton) {
        skeletons.add(skeleton);
      }
    }
  }

  return skeletons;
}

export function getCanonicalProtectedTokenContracts(chainId, assetIds = null) {
  const contracts = new Set();
  const definitions = assetIds == null
    ? PROTECTED_TOKEN_DEFINITIONS
    : assetIds
        .map((assetId) => PROTECTED_TOKEN_DEFINITION_BY_ID.get(assetId))
        .filter(Boolean);

  for (const definition of definitions) {
    const chainContracts = definition.canonicalContractsByChain[chainId];

    if (!chainContracts) {
      continue;
    }

    for (const contractAddress of normalizeContractList(chainContracts)) {
      contracts.add(contractAddress);
    }
  }

  return contracts;
}
