import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { groupWalletEventsByTransaction } from '../src/modules/events/eventActivityGrouper.js';

const wallet = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Test Wallet',
  address: '0x1111111111111111111111111111111111111111'
};

let eventSequence = 0;

function buildEvent(overrides = {}) {
  eventSequence += 1;

  return {
    id: overrides.id ?? `event-${eventSequence}`,
    walletId: wallet.id,
    chainId: overrides.chainId ?? 'ethereum-mainnet',
    transactionHash: overrides.transactionHash ?? `0x${String(eventSequence).padStart(64, '0')}`,
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

  test('does not group NFT mints from the zero address', () => {
    const transactionHash = `0x${'2'.repeat(64)}`;
    const payment = buildEvent({ transactionHash, direction: 'outgoing' });
    const mint = buildNftEvent({
      transactionHash,
      direction: 'incoming',
      fromAddress: '0x0000000000000000000000000000000000000000'
    });
    const result = groupWalletEventsByTransaction([payment, mint], wallet);

    assert.equal(result.length, 2);
    assert.ok(result.every((item) => item.itemType === 'event'));
  });
});
