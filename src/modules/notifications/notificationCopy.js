const amountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8
});

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

function isNftEvent(event) {
  return event.assetType === 'nft'
    || event.eventType === 'nft_transfer'
    || event.eventType === 'nft_buy'
    || event.eventType === 'nft_sell';
}

function formatAmount(amount) {
  if (amount == null || String(amount).trim() === '') {
    return null;
  }

  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return String(amount);
  }

  const formattedAmount = amountFormatter.format(numericAmount);

  // Preserve very small nonzero amounts that would otherwise display as zero.
  if (numericAmount !== 0 && Number(formattedAmount.replaceAll(',', '')) === 0) {
    return String(amount);
  }

  return formattedAmount;
}

function resolveTransferVerb(direction) {
  if (direction === 'incoming') {
    return 'received';
  }

  if (direction === 'outgoing') {
    return 'sent';
  }

  return 'transferred';
}

function resolveWalletDisplay(walletLabel) {
  return typeof walletLabel === 'string' && walletLabel.trim()
    ? walletLabel.trim()
    : 'Wallet';
}

function resolveNftLabel(event) {
  const assetName = typeof event.assetName === 'string' && event.assetName.trim()
    ? event.assetName.trim()
    : null;
  const assetSymbol = typeof event.assetSymbol === 'string' && event.assetSymbol.trim()
    ? event.assetSymbol.trim()
    : null;
  const tokenId = event.nftTokenId != null && String(event.nftTokenId).trim()
    ? String(event.nftTokenId).trim()
    : null;
  const assetLabel = assetName || assetSymbol;

  if (assetLabel && tokenId) {
    return `${assetLabel} #${tokenId}`;
  }

  if (tokenId) {
    return `NFT #${tokenId}`;
  }

  return assetLabel || 'NFT transfer';
}

function formatApproximateUsd(event) {
  if (!String(event.usdValueStatus ?? '').startsWith('priced_')) {
    return null;
  }

  const numericUsdValue = Number(event.usdValue);

  if (!Number.isFinite(numericUsdValue)) {
    return null;
  }

  return `≈ ${usdFormatter.format(numericUsdValue)}`;
}

export function buildWalletEventNotificationCopy({ walletLabel, event }) {
  const walletDisplay = resolveWalletDisplay(walletLabel);
  const transferVerb = resolveTransferVerb(event.direction);

  if (isNftEvent(event)) {
    return {
      title: `${walletDisplay} ${transferVerb} an NFT`,
      body: resolveNftLabel(event)
    };
  }

  const amount = formatAmount(event.amount);
  const asset = event.assetSymbol || event.assetName || 'asset';
  const transferDisplay = [amount, asset].filter(Boolean).join(' ');
  const fallbackBody = event.eventType === 'native_transfer'
    ? 'Native transfer'
    : event.eventType === 'token_transfer'
      ? 'Token transfer'
      : 'Wallet activity';

  return {
    title: `${walletDisplay} ${transferVerb} ${transferDisplay}`,
    body: formatApproximateUsd(event) || fallbackBody
  };
}

function toFirebaseDataValue(value) {
  return value == null ? '' : String(value);
}

export function buildWalletEventNotificationData(event) {
  return {
    walletId: toFirebaseDataValue(event.walletId),
    walletEventId: toFirebaseDataValue(event.id),
    transactionHash: toFirebaseDataValue(event.transactionHash),
    eventType: toFirebaseDataValue(event.eventType),
    chainId: toFirebaseDataValue(event.chainId),
    usdValue: toFirebaseDataValue(event.usdValue),
    usdValueStatus: toFirebaseDataValue(event.usdValueStatus),
    nftContractAddress: toFirebaseDataValue(event.nftContractAddress),
    nftTokenId: toFirebaseDataValue(event.nftTokenId),
    assetSymbol: toFirebaseDataValue(event.assetSymbol),
    amount: toFirebaseDataValue(event.amount)
  };
}
