import {
  getCanonicalProtectedTokenContracts,
  getProtectedTokenSkeletons
} from './protectedTokens.registry.js';
import {
  buildAsciiSkeleton,
  normalizeAddress
} from './tokenIdentity.utils.js';

export { buildAsciiSkeleton } from './tokenIdentity.utils.js';

const ETH_FAMILY_PROTECTED_ASSET_IDS = ['ETH', 'WETH'];
const ETH_IMPERSONATION_TARGETS = getProtectedTokenSkeletons(ETH_FAMILY_PROTECTED_ASSET_IDS);

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
  const allowlistedContracts = getCanonicalProtectedTokenContracts(chainId, ETH_FAMILY_PROTECTED_ASSET_IDS);

  if (normalizedContractAddress && allowlistedContracts.has(normalizedContractAddress)) {
    return {
      shouldReject: false,
      normalizedSymbol: buildAsciiSkeleton(assetSymbol),
      normalizedName: buildAsciiSkeleton(assetName)
    };
  }

  const normalizedSymbol = buildAsciiSkeleton(assetSymbol);
  const normalizedName = buildAsciiSkeleton(assetName);
  const symbolMatches = normalizedSymbol && ETH_IMPERSONATION_TARGETS.has(normalizedSymbol);
  const nameMatches = normalizedName && ETH_IMPERSONATION_TARGETS.has(normalizedName);

  return {
    shouldReject: Boolean(symbolMatches || nameMatches),
    normalizedSymbol,
    normalizedName,
    rejectionReason: symbolMatches || nameMatches ? 'token_impersonates_native_eth' : null
  };
}
