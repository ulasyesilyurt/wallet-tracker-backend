import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { groupWalletEventsByTransaction } from '../src/modules/events/eventActivityGrouper.js';

const wallet = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Test Wallet',
  address: '0x1111111111111111111111111111111111111111'
};
const zeroAddress = '0x0000000000000000000000000000000000000000';

let eventSequence = 0;

function buildEvent(overrides = {}) {
  eventSequence += 1;

  return {
    id: overrides.id ?? `event-${eventSequence}`,
    walletId: wallet.id,
    chainId: overrides.chainId ?? 'ethereum-mainnet',
    transactionHash: Object.hasOwn(overrides, 'transactionHash')
      ? overrides.transactionHash
      : `0x${String(eventSequence).padStart(64, '0')}`,
    eventType: overrides.eventType ?? 'native_transfer',
    assetType: overrides.assetType ?? 'coin',
    assetSymbol: overrides.assetSymbol ?? 'ETH',
    assetName: overrides.assetName ?? 'Ethereum',
    amount: Object.hasOwn(overrides, 'amount') ? overrides.amount : '1',
    usdValue: Object.hasOwn(overrides, 'usdValue') ? overrides.usdValue : '3000.00',
    usdValueStatus: overrides.usdValueStatus ?? 'priced_native_eth',
    assetContractAddress: overrides.assetContractAddress ?? null,
    assetTokenId: overrides.assetTokenId ?? null,
    assetImageUrl: null,
    assetDecimals: null,
    direction: Object.hasOwn(overrides, 'direction') ? overrides.direction : 'outgoing',
    fromAddress: overrides.fromAddress ?? wallet.address,
    toAddress: overrides.toAddress ?? '0x2222222222222222222222222222222222222222',
    occurredAt: overrides.occurredAt ?? '2026-07-19T12:00:00.000Z'
  };
}

function buildNftEvent(overrides = {}) {
  return buildEvent({
    eventType: 'nft_transfer',
    assetType: 'nft',
    assetSymbol: 'TEST',
    assetName: 'Test Collection',
    amount: '1',
    usdValue: null,
    usdValueStatus: 'unsupported_nft',
    assetContractAddress: '0x3333333333333333333333333333333333333333',
    assetTokenId: String(eventSequence + 1),
    ...overrides
  });
}

describe('wallet event transaction grouping', () => {
  test('wraps a simple raw event additively', () => {
    const event = buildEvent();
    const result = groupWalletEventsByTransaction([event], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'event');
    assert.deepEqual(result[0].sourceEventIds, [event.id]);
    assert.equal(result[0].transactionHash, event.transactionHash);
  });

  test('groups an outgoing payment and incoming NFT as an NFT purchase', () => {
    const transactionHash = `0x${'a'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'outgoing', usdValue: '600.00' });
    const nft = buildNftEvent({ transactionHash, direction: 'incoming', assetTokenId: '123' });
    const result = groupWalletEventsByTransaction([payment, nft], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'transaction');
    assert.equal(result[0].activityType, 'nft_purchase');
    assert.equal(result[0].usdValue, '600.00');
    assert.equal(result[0].usdValueStatus, 'priced_group_payment');
    assert.deepEqual(result[0].sourceEventIds, [payment.id, nft.id]);
    assert.deepEqual(result[0].sentAssets.map((asset) => asset.eventId), [payment.id]);
    assert.deepEqual(result[0].receivedAssets.map((asset) => asset.eventId), [nft.id]);
  });

  test('groups an incoming payment and outgoing NFT as an NFT sale', () => {
    const transactionHash = `0x${'b'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'incoming', usdValue: '825.00' });
    const nft = buildNftEvent({ transactionHash, direction: 'outgoing', assetTokenId: '456' });
    const result = groupWalletEventsByTransaction([payment, nft], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].activityType, 'nft_sale');
    assert.equal(result[0].usdValue, '825.00');
    assert.deepEqual(result[0].sentAssets.map((asset) => asset.eventId), [nft.id]);
    assert.deepEqual(result[0].receivedAssets.map((asset) => asset.eventId), [payment.id]);
  });

  test('groups a batch NFT purchase and includes every source event ID', () => {
    const transactionHash = `0x${'c'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'outgoing' });
    const firstNft = buildNftEvent({ transactionHash, direction: 'incoming', assetTokenId: '1' });
    const secondNft = buildNftEvent({ transactionHash, direction: 'incoming', assetTokenId: '2' });
    const result = groupWalletEventsByTransaction([payment, firstNft, secondNft], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].activityType, 'nft_purchase');
    assert.deepEqual(result[0].sourceEventIds, [payment.id, firstNft.id, secondNft.id]);
    assert.equal(result[0].receivedAssets.length, 2);
  });

  test('leaves an NFT-only transfer as a raw event', () => {
    const nft = buildNftEvent({ direction: 'incoming' });
    const result = groupWalletEventsByTransaction([nft], wallet);

    assert.equal(result[0].itemType, 'event');
    assert.deepEqual(result[0].sourceEventIds, [nft.id]);
  });

  test('leaves a fungible-only transfer as a raw event', () => {
    const payment = buildEvent({ direction: 'incoming' });
    const result = groupWalletEventsByTransaction([payment], wallet);

    assert.equal(result[0].itemType, 'event');
    assert.deepEqual(result[0].sourceEventIds, [payment.id]);
  });

  test('leaves an ambiguous transaction with NFTs moving both directions raw', () => {
    const transactionHash = `0x${'d'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'outgoing' });
    const incomingNft = buildNftEvent({ transactionHash, direction: 'incoming' });
    const outgoingNft = buildNftEvent({ transactionHash, direction: 'outgoing' });
    const result = groupWalletEventsByTransaction([payment, incomingNft, outgoingNft], wallet);

    assert.equal(result.length, 3);
    assert.ok(result.every((item) => item.itemType === 'event'));
  });

  test('leaves a transaction with unknown direction raw', () => {
    const transactionHash = `0x${'e'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: null });
    const nft = buildNftEvent({ transactionHash, direction: 'incoming' });
    const result = groupWalletEventsByTransaction([payment, nft], wallet);

    assert.equal(result.length, 2);
    assert.ok(result.every((item) => item.itemType === 'event'));
  });

  test('totals payment USD only when every payment leg is priced', () => {
    const pricedHash = `0x${'f'.repeat(64)}`;
    const firstPayment = buildEvent({ transactionHash: pricedHash, usdValue: '300.25' });
    const secondPayment = buildEvent({
      transactionHash: pricedHash,
      eventType: 'token_transfer',
      assetType: 'token',
      assetSymbol: 'USDC',
      usdValue: '149.75'
    });
    const pricedNft = buildNftEvent({ transactionHash: pricedHash, direction: 'incoming' });
    const pricedResult = groupWalletEventsByTransaction(
      [firstPayment, secondPayment, pricedNft],
      wallet
    );

    assert.equal(pricedResult[0].usdValue, '450.00');
    assert.equal(pricedResult[0].usdValueStatus, 'priced_group_payment');

    const unpricedHash = `0x${'1'.repeat(64)}`;
    const pricedLeg = buildEvent({ transactionHash: unpricedHash, usdValue: '300.00' });
    const unpricedLeg = buildEvent({
      transactionHash: unpricedHash,
      eventType: 'token_transfer',
      assetType: 'token',
      usdValue: null,
      usdValueStatus: 'unpriced'
    });
    const unpricedNft = buildNftEvent({ transactionHash: unpricedHash, direction: 'incoming' });
    const unpricedResult = groupWalletEventsByTransaction(
      [pricedLeg, unpricedLeg, unpricedNft],
      wallet
    );

    assert.equal(unpricedResult[0].usdValue, null);
    assert.equal(unpricedResult[0].usdValueStatus, 'unpriced_group_payment');
  });

  test('groups a free single-NFT mint without reporting zero USD', () => {
    const transactionHash = `0x${'2'.repeat(64)}`;
    const mint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([mint], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'transaction');
    assert.equal(result[0].activityType, 'nft_mint');
    assert.equal(result[0].usdValue, null);
    assert.equal(result[0].usdValueStatus, 'unpriced_group_payment');
    assert.deepEqual(result[0].sourceEventIds, [mint.id]);
    assert.deepEqual(result[0].sentAssets, []);
    assert.deepEqual(result[0].receivedAssets.map((asset) => asset.eventId), [mint.id]);
  });

  test('groups an outgoing native payment and zero-address NFT as a paid mint', () => {
    const transactionHash = `0x${'3'.repeat(64)}`;
    const payment = buildEvent({
      transactionHash,
      direction: 'outgoing',
      amount: '0.2',
      usdValue: '600.00'
    });
    const mint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([payment, mint], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].activityType, 'nft_mint');
    assert.equal(result[0].usdValue, '600.00');
    assert.equal(result[0].usdValueStatus, 'priced_group_payment');
    assert.deepEqual(result[0].sourceEventIds, [payment.id, mint.id]);
    assert.deepEqual(result[0].sentAssets.map((asset) => asset.eventId), [payment.id]);
    assert.deepEqual(result[0].receivedAssets.map((asset) => asset.eventId), [mint.id]);
  });

  test('groups an outgoing ERC-20 payment and zero-address NFT as a paid mint', () => {
    const transactionHash = `0x${'4'.repeat(64)}`;
    const payment = buildEvent({
      transactionHash,
      eventType: 'token_transfer',
      assetType: 'token',
      assetSymbol: 'USDC',
      assetName: 'USD Coin',
      assetContractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      direction: 'outgoing',
      amount: '125',
      usdValue: '125.00',
      usdValueStatus: 'priced_stablecoin'
    });
    const mint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([payment, mint], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].activityType, 'nft_mint');
    assert.equal(result[0].usdValue, '125.00');
    assert.equal(result[0].sentAssets[0].assetType, 'token');
    assert.equal(result[0].sentAssets[0].assetSymbol, 'USDC');
  });

  test('groups multiple zero-address NFTs as one batch mint', () => {
    const transactionHash = `0x${'5'.repeat(64)}`;
    const firstMint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address,
      assetTokenId: '10'
    });
    const secondMint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address,
      assetTokenId: '11'
    });
    const result = groupWalletEventsByTransaction([firstMint, secondMint], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].activityType, 'nft_mint');
    assert.deepEqual(result[0].sourceEventIds, [firstMint.id, secondMint.id]);
    assert.equal(result[0].receivedAssets.length, 2);
    assert.equal(result[0].usdValue, null);
  });

  test('leaves a nonzero-address incoming NFT without payment raw', () => {
    const nft = buildNftEvent({
      direction: 'incoming',
      fromAddress: '0x5555555555555555555555555555555555555555',
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([nft], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'event');
  });

  test('keeps a nonzero-address incoming NFT with payment classified as a purchase', () => {
    const transactionHash = `0x${'6'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'outgoing' });
    const nft = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: '0x5555555555555555555555555555555555555555',
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([payment, nft], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].activityType, 'nft_purchase');
  });

  test('leaves mixed zero-address and nonzero-address incoming NFTs raw', () => {
    const transactionHash = `0x${'7'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'outgoing' });
    const mint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const transfer = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: '0x5555555555555555555555555555555555555555',
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([payment, mint, transfer], wallet);

    assert.equal(result.length, 3);
    assert.ok(result.every((item) => item.itemType === 'event'));
  });

  test('leaves an outgoing NFT burn to the zero address raw', () => {
    const burn = buildNftEvent({
      direction: 'outgoing',
      fromAddress: wallet.address,
      toAddress: zeroAddress
    });
    const result = groupWalletEventsByTransaction([burn], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'event');
  });

  test('leaves a zero-address NFT with unknown direction raw', () => {
    const mint = buildNftEvent({
      direction: null,
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([mint], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'event');
  });

  test('leaves a zero-address NFT without a transaction hash raw', () => {
    const mint = buildNftEvent({
      transactionHash: null,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const result = groupWalletEventsByTransaction([mint], wallet);

    assert.equal(result.length, 1);
    assert.equal(result[0].itemType, 'event');
  });

  test('totals all priced mint payment legs and rejects partial valuation', () => {
    const pricedHash = `0x${'8'.repeat(64)}`;
    const nativePayment = buildEvent({
      transactionHash: pricedHash,
      direction: 'outgoing',
      usdValue: '300.25'
    });
    const tokenPayment = buildEvent({
      transactionHash: pricedHash,
      eventType: 'token_transfer',
      assetType: 'token',
      assetSymbol: 'USDC',
      direction: 'outgoing',
      usdValue: '149.75'
    });
    const pricedMint = buildNftEvent({
      transactionHash: pricedHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const pricedResult = groupWalletEventsByTransaction(
      [nativePayment, tokenPayment, pricedMint],
      wallet
    );

    assert.equal(pricedResult[0].activityType, 'nft_mint');
    assert.equal(pricedResult[0].usdValue, '450.00');
    assert.equal(pricedResult[0].usdValueStatus, 'priced_group_payment');

    const unpricedHash = `0x${'9'.repeat(64)}`;
    const unpricedPayment = buildEvent({
      transactionHash: unpricedHash,
      eventType: 'token_transfer',
      assetType: 'token',
      direction: 'outgoing',
      usdValue: null,
      usdValueStatus: 'unpriced'
    });
    const unpricedMint = buildNftEvent({
      transactionHash: unpricedHash,
      direction: 'incoming',
      fromAddress: zeroAddress,
      toAddress: wallet.address
    });
    const unpricedResult = groupWalletEventsByTransaction(
      [unpricedPayment, unpricedMint],
      wallet
    );

    assert.equal(unpricedResult[0].activityType, 'nft_mint');
    assert.equal(unpricedResult[0].usdValue, null);
    assert.equal(unpricedResult[0].usdValueStatus, 'unpriced_group_payment');
  });
});
