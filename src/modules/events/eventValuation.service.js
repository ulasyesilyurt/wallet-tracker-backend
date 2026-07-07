import { logger } from '../../config/logger.js';
import { fetchChainEthUsdPrice } from '../holdings/holdings.provider.js';
import { detectNativeEthImpersonation } from './eventSpamFilter.js';
import { getCanonicalProtectedTokenContracts } from './protectedTokens.registry.js';
import { normalizeAddress } from './tokenIdentity.utils.js';

const eventValuationLogger = logger.child({ module: 'event-valuation' });
const CANONICAL_WETH_ASSET_IDS = ['WETH'];
const CANONICAL_STABLECOIN_ASSET_IDS = ['USDC', 'USDT', 'DAI'];

function roundUsdValue(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.round(numericValue * 100) / 100;
}

function multiplyAmountByUsd(amount, usdPrice) {
  const numericAmount = Number(amount);
  const numericPrice = Number(usdPrice);

  if (!Number.isFinite(numericAmount) || !Number.isFinite(numericPrice)) {
    return null;
  }

  return roundUsdValue(numericAmount * numericPrice);
}

function buildEnrichment({
  usdValue = null,
  usdValueStatus,
  usdValueSource = null,
  usdValueCalculatedAt = new Date().toISOString()
}) {
  return {
    usdValue,
    usdValueStatus,
    usdValueSource,
    usdValueCalculatedAt
  };
}

function isNftLikeEvent(event) {
  return event.assetType === 'nft' || event.eventType === 'nft_transfer' || event.eventType === 'nft_buy' || event.eventType === 'nft_sell';
}

export async function enrichWalletEventUsdValue(
  event,
  {
    getEthUsdPrice = fetchChainEthUsdPrice
  } = {},
  log = eventValuationLogger
) {
  if (isNftLikeEvent(event)) {
    return {
      ...event,
      ...buildEnrichment({
        usdValueStatus: 'unsupported_nft'
      })
    };
  }

  if (event.eventType === 'native_transfer' || event.assetType === 'coin') {
    const ethUsdPrice = await getEthUsdPrice(event.chainId).catch((error) => {
      log.warn(
        {
          err: error,
          chainId: event.chainId,
          transactionHash: event.transactionHash,
          eventType: event.eventType
        },
        'Native event USD valuation failed while fetching ETH price'
      );
      return null;
    });
    const usdValue = multiplyAmountByUsd(event.amount, ethUsdPrice);

    return {
      ...event,
      ...buildEnrichment({
        usdValue,
        usdValueStatus: usdValue != null ? 'priced_native_eth' : 'unpriced',
        usdValueSource: usdValue != null ? 'eth_usd' : null
      })
    };
  }

  if (event.eventType !== 'token_transfer' || event.assetType !== 'token') {
    return {
      ...event,
      ...buildEnrichment({
        usdValueStatus: 'not_applicable'
      })
    };
  }

  const normalizedTokenAddress = normalizeAddress(event.tokenContractAddress);

  if (!normalizedTokenAddress) {
    return {
      ...event,
      ...buildEnrichment({
        usdValueStatus: 'unknown_token'
      })
    };
  }

  const canonicalWethContracts = getCanonicalProtectedTokenContracts(event.chainId, CANONICAL_WETH_ASSET_IDS);

  if (canonicalWethContracts.has(normalizedTokenAddress)) {
    const ethUsdPrice = await getEthUsdPrice(event.chainId).catch((error) => {
      log.warn(
        {
          err: error,
          chainId: event.chainId,
          transactionHash: event.transactionHash,
          tokenContractAddress: normalizedTokenAddress
        },
        'Canonical WETH event USD valuation failed while fetching ETH price'
      );
      return null;
    });
    const usdValue = multiplyAmountByUsd(event.amount, ethUsdPrice);

    return {
      ...event,
      ...buildEnrichment({
        usdValue,
        usdValueStatus: usdValue != null ? 'priced_canonical_weth' : 'unpriced',
        usdValueSource: usdValue != null ? 'canonical_weth_eth_parity' : null
      })
    };
  }

  const canonicalStablecoinContracts = getCanonicalProtectedTokenContracts(event.chainId, CANONICAL_STABLECOIN_ASSET_IDS);

  if (canonicalStablecoinContracts.has(normalizedTokenAddress)) {
    const usdValue = roundUsdValue(event.amount);

    return {
      ...event,
      ...buildEnrichment({
        usdValue,
        usdValueStatus: usdValue != null ? 'priced_canonical_stablecoin' : 'unpriced',
        usdValueSource: usdValue != null ? 'canonical_stablecoin_parity' : null
      })
    };
  }

  const impersonationCheck = detectNativeEthImpersonation({
    chainId: event.chainId,
    eventType: event.eventType,
    tokenStandard: 'erc20',
    contractAddress: normalizedTokenAddress,
    assetSymbol: event.assetSymbol,
    assetName: event.assetName
  });

  if (impersonationCheck.shouldReject) {
    return {
      ...event,
      ...buildEnrichment({
        usdValueStatus: 'suspicious'
      })
    };
  }

  return {
    ...event,
    ...buildEnrichment({
      usdValueStatus: 'unknown_token'
    })
  };
}
