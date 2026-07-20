const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i;

function isKnownDirection(event) {
  return event.direction === 'incoming' || event.direction === 'outgoing';
}

function isFungibleTransfer(event) {
  return (
    (event.eventType === 'native_transfer' && event.assetType === 'coin') ||
    (event.eventType === 'token_transfer' && event.assetType === 'token')
  );
}

function isNftTransfer(event) {
  return event.eventType === 'nft_transfer' && event.assetType === 'nft';
}

function hasPositiveAmount(event) {
  if (event.amount === null || event.amount === undefined) {
    return false;
  }

  const normalizedAmount = String(event.amount).trim().replace(/^\+/, '');

  return (
    /^\d+(?:\.\d+)?$/.test(normalizedAmount) &&
    /[1-9]/.test(normalizedAmount)
  );
}

function isZeroAddress(address) {
  return ZERO_ADDRESS_PATTERN.test(address ?? '');
}

function isNftMint(event) {
  return (
    isNftTransfer(event) &&
    event.direction === 'incoming' &&
    isZeroAddress(event.fromAddress)
  );
}

function isNftBurn(event) {
  return (
    isNftTransfer(event) &&
    event.direction === 'outgoing' &&
    isZeroAddress(event.toAddress)
  );
}

function classifyNftActivity(events) {
  if (events.length === 0) {
    return null;
  }

  if (
    events.some(
      (event) =>
        !event.transactionHash ||
        !isKnownDirection(event) ||
        (!isFungibleTransfer(event) && !isNftTransfer(event)) ||
        isNftBurn(event)
    )
  ) {
    return null;
  }

  const outgoingPayments = events.filter(
    (event) =>
      event.direction === 'outgoing' &&
      isFungibleTransfer(event) &&
      hasPositiveAmount(event)
  );
  const incomingPayments = events.filter(
    (event) =>
      event.direction === 'incoming' &&
      isFungibleTransfer(event) &&
      hasPositiveAmount(event)
  );
  const outgoingNfts = events.filter(
    (event) => event.direction === 'outgoing' && isNftTransfer(event)
  );
  const incomingNfts = events.filter(
    (event) => event.direction === 'incoming' && isNftTransfer(event)
  );

  if (
    outgoingPayments.length +
      incomingPayments.length +
      outgoingNfts.length +
      incomingNfts.length !==
    events.length
  ) {
    return null;
  }

  const mintedNfts = incomingNfts.filter(isNftMint);
  const hasMintedNfts = mintedNfts.length > 0;
  const hasMixedMintSources =
    hasMintedNfts && mintedNfts.length !== incomingNfts.length;

  if (hasMixedMintSources) {
    return null;
  }

  if (
    hasMintedNfts &&
    outgoingNfts.length === 0 &&
    incomingPayments.length === 0
  ) {
    return {
      activityType: 'nft_mint',
      paymentEvents: outgoingPayments
    };
  }

  // Any remaining zero-address NFT combination is ambiguous rather than a purchase.
  if (hasMintedNfts) {
    return null;
  }

  if (
    outgoingPayments.length > 0 &&
    incomingNfts.length > 0 &&
    outgoingNfts.length === 0 &&
    incomingPayments.length === 0
  ) {
    return {
      activityType: 'nft_purchase',
      paymentEvents: outgoingPayments
    };
  }

  if (
    incomingPayments.length > 0 &&
    outgoingNfts.length > 0 &&
    incomingNfts.length === 0 &&
    outgoingPayments.length === 0
  ) {
    return {
      activityType: 'nft_sale',
      paymentEvents: incomingPayments
    };
  }

  return null;
}

function mapAssetLeg(event) {
  return {
    eventId: event.id,
    direction: event.direction,
    assetType: event.assetType,
    assetSymbol: event.assetSymbol,
    assetName: event.assetName,
    amount: event.amount,
    usdValue: event.usdValue,
    usdValueStatus: event.usdValueStatus,
    assetContractAddress: event.assetContractAddress,
    assetTokenId: event.assetTokenId,
    assetImageUrl: null,
    assetDecimals: null
  };
}

function sumPaymentUsdValue(paymentEvents) {
  if (paymentEvents.length === 0) {
    return null;
  }

  const values = paymentEvents.map((event) => {
    if (event.usdValue === null || event.usdValue === undefined) {
      return null;
    }

    const value = Number(event.usdValue);

    return Number.isFinite(value) && value >= 0 ? value : null;
  });

  if (values.some((value) => value === null)) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0).toFixed(2);
}

function mapRawEventItem(event) {
  return {
    ...event,
    itemType: 'event',
    sourceEventIds: [event.id]
  };
}

function mapGroupedTransaction(events, wallet, classification) {
  const paymentUsdValue = sumPaymentUsdValue(classification.paymentEvents);
  const firstEvent = events[0];

  return {
    itemType: 'transaction',
    activityType: classification.activityType,
    id: `tx:${wallet.id}:${firstEvent.chainId}:${firstEvent.transactionHash}`,
    walletId: wallet.id,
    walletLabel: wallet.label ?? null,
    walletAddress: wallet.address,
    chainId: firstEvent.chainId,
    transactionHash: firstEvent.transactionHash,
    occurredAt: firstEvent.occurredAt,
    sourceEventIds: events.map((event) => event.id),
    usdValue: paymentUsdValue,
    usdValueStatus:
      paymentUsdValue === null ? 'unpriced_group_payment' : 'priced_group_payment',
    sentAssets: events
      .filter((event) => event.direction === 'outgoing')
      .map(mapAssetLeg),
    receivedAssets: events
      .filter((event) => event.direction === 'incoming')
      .map(mapAssetLeg)
  };
}

export function groupWalletEventsByTransaction(events, wallet) {
  const eventGroups = new Map();

  for (const event of events) {
    const groupKey = event.transactionHash
      ? `${event.walletId}:${event.chainId}:${event.transactionHash}`
      : `event:${event.id}`;
    const group = eventGroups.get(groupKey) ?? [];

    group.push(event);
    eventGroups.set(groupKey, group);
  }

  return Array.from(eventGroups.values()).flatMap((group) => {
    const classification = classifyNftActivity(group);

    if (!classification) {
      return group.map(mapRawEventItem);
    }

    return [mapGroupedTransaction(group, wallet, classification)];
  });
}
