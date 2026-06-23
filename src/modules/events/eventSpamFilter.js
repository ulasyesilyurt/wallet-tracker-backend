import {
  BASE_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID
} from '../chains/chains.config.js';

const NATIVE_ETH_IMPERSONATION_TARGETS = new Set(['ETH', 'ETHEREUM']);
const COMBINING_OR_INVISIBLE_CHARACTERS = /[\p{M}\p{Cf}\p{Cc}\p{Cs}]/gu;
const ASCII_ALPHANUMERIC = /^[A-Z0-9]$/;

const CONFUSABLE_ASCII_MAP = new Map([
  ['Ε', 'E'],
  ['Е', 'E'],
  ['ε', 'E'],
  ['е', 'E'],
  ['Τ', 'T'],
  ['Т', 'T'],
  ['τ', 'T'],
  ['т', 'T'],
  ['Η', 'H'],
  ['Н', 'H'],
  ['һ', 'H'],
  ['н', 'H'],
  ['һ', 'H']
]);

const NATIVE_ETH_IMPERSONATION_ALLOWLIST = new Map([
  [
    ETHEREUM_MAINNET_CHAIN_ID,
    new Set([
      '0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase()
    ])
  ],
  [
    BASE_MAINNET_CHAIN_ID,
    new Set([
      '0x4200000000000000000000000000000000000006'
    ])
  ]
]);

function normalizeAddress(address) {
  return typeof address === 'string' ? address.trim().toLowerCase() : null;
}

export function buildAsciiSkeleton(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value
    .normalize('NFKD')
    .replace(COMBINING_OR_INVISIBLE_CHARACTERS, '')
    .trim()
    .toUpperCase();

  if (!normalizedValue) {
    return null;
  }

  let skeleton = '';

  for (const character of normalizedValue) {
    const mappedCharacter = CONFUSABLE_ASCII_MAP.get(character) ?? character;

    if (ASCII_ALPHANUMERIC.test(mappedCharacter)) {
      skeleton += mappedCharacter;
    }
  }

  return skeleton || null;
}

export function detectNativeEthImpersonation({
  chainId,
  eventType,
  tokenStandard,
  contractAddress,
  assetSymbol,
  assetName
}) {
  if (eventType !== 'token_transfer' || tokenStandard !== 'erc20') {
    return {
      shouldReject: false,
      normalizedSymbol: buildAsciiSkeleton(assetSymbol),
      normalizedName: buildAsciiSkeleton(assetName)
    };
  }

  const normalizedContractAddress = normalizeAddress(contractAddress);
  const allowlistedContracts = NATIVE_ETH_IMPERSONATION_ALLOWLIST.get(chainId) ?? new Set();

  if (normalizedContractAddress && allowlistedContracts.has(normalizedContractAddress)) {
    return {
      shouldReject: false,
      normalizedSymbol: buildAsciiSkeleton(assetSymbol),
      normalizedName: buildAsciiSkeleton(assetName)
    };
  }

  const normalizedSymbol = buildAsciiSkeleton(assetSymbol);
  const normalizedName = buildAsciiSkeleton(assetName);
  const symbolMatches = normalizedSymbol && NATIVE_ETH_IMPERSONATION_TARGETS.has(normalizedSymbol);
  const nameMatches = normalizedName && NATIVE_ETH_IMPERSONATION_TARGETS.has(normalizedName);

  return {
    shouldReject: Boolean(symbolMatches || nameMatches),
    normalizedSymbol,
    normalizedName,
    rejectionReason: symbolMatches || nameMatches ? 'token_impersonates_native_eth' : null
  };
}
