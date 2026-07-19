import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildWalletEventNotificationCopy,
  buildWalletEventNotificationData
} from '../src/modules/notifications/notificationCopy.js';
import { buildSafeFirebaseLogMetadata } from '../src/modules/notifications/firebaseLogMetadata.js';

function buildEvent(overrides = {}) {
  return {
    id: 'd6e5a961-a769-4b35-bd19-067867dd3020',
    walletId: '4be0b63f-b584-463d-a484-ff34bd46a90b',
    chainId: 'ethereum-mainnet',
    transactionHash: '0x1234',
    eventType: 'native_transfer',
    assetType: 'coin',
    assetSymbol: 'ETH',
    assetName: 'Ethereum',
    amount: '1',
    direction: 'incoming',
    usdValue: '3000',
    usdValueStatus: 'priced_native_eth',
    nftContractAddress: null,
    nftTokenId: null,
    ...overrides
  };
}

describe('wallet event notification copy', () => {
  test('formats incoming native ETH with USD value', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Whale Wallet',
      event: buildEvent({ amount: '1.25', usdValue: '4250' })
    });

    assert.deepEqual(copy, {
      title: 'Whale Wallet received 1.25 ETH',
      body: '≈ $4,250'
    });
  });

  test('formats outgoing native ETH with USD value', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Smart Wallet',
      event: buildEvent({ direction: 'outgoing', amount: '3.2', usdValue: '10850' })
    });

    assert.deepEqual(copy, {
      title: 'Smart Wallet sent 3.2 ETH',
      body: '≈ $10,850'
    });
  });

  test('formats stablecoin amount and USD value', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Whale Wallet',
      event: buildEvent({
        eventType: 'token_transfer',
        assetType: 'token',
        assetSymbol: 'USDC',
        assetName: 'USD Coin',
        amount: '1250',
        usdValue: '1250',
        usdValueStatus: 'priced_canonical_stablecoin'
      })
    });

    assert.deepEqual(copy, {
      title: 'Whale Wallet received 1,250 USDC',
      body: '≈ $1,250'
    });
  });

  test('formats canonical WETH like a fungible transfer', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Base Wallet',
      event: buildEvent({
        chainId: 'base-mainnet',
        eventType: 'token_transfer',
        assetType: 'token',
        assetSymbol: 'WETH',
        assetName: 'Wrapped Ether',
        amount: '2',
        direction: 'outgoing',
        usdValue: '6820',
        usdValueStatus: 'priced_canonical_weth'
      })
    });

    assert.deepEqual(copy, {
      title: 'Base Wallet sent 2 WETH',
      body: '≈ $6,820'
    });
  });

  test('formats a future priced ERC-20 consistently', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Whale Wallet',
      event: buildEvent({
        eventType: 'token_transfer',
        assetType: 'token',
        assetSymbol: 'TOSHI',
        assetName: 'Toshi',
        amount: '42000',
        usdValue: '2430',
        usdValueStatus: 'priced_token'
      })
    });

    assert.deepEqual(copy, {
      title: 'Whale Wallet received 42,000 TOSHI',
      body: '≈ $2,430'
    });
  });

  test('never displays zero USD for an unpriced event', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Wallet',
      event: buildEvent({
        eventType: 'token_transfer',
        assetType: 'token',
        assetSymbol: 'XYZ',
        amount: '500',
        usdValue: null,
        usdValueStatus: 'unpriced'
      })
    });

    assert.equal(copy.title, 'Wallet received 500 XYZ');
    assert.equal(copy.body, 'Token transfer');
    assert.equal(copy.body.includes('$0'), false);
  });

  test('uses neutral wording when direction is missing', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Whale Wallet',
      event: buildEvent({ direction: null })
    });

    assert.equal(copy.title, 'Whale Wallet transferred 1 ETH');
  });

  test('formats NFT copy with collection name and token ID', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: 'Whale Wallet',
      event: buildEvent({
        eventType: 'nft_transfer',
        assetType: 'nft',
        assetSymbol: 'PPG',
        assetName: 'Pudgy Penguins',
        amount: '1',
        usdValue: null,
        usdValueStatus: 'unsupported_nft',
        nftTokenId: '1234'
      })
    });

    assert.deepEqual(copy, {
      title: 'Whale Wallet received an NFT',
      body: 'Pudgy Penguins #1234'
    });
  });

  test('uses a safe NFT fallback without metadata', () => {
    const copy = buildWalletEventNotificationCopy({
      walletLabel: null,
      event: buildEvent({
        eventType: 'nft_transfer',
        assetType: 'nft',
        assetSymbol: null,
        assetName: null,
        amount: '1',
        direction: 'outgoing',
        usdValue: null,
        usdValueStatus: 'unsupported_nft',
        nftTokenId: null
      })
    });

    assert.deepEqual(copy, {
      title: 'Wallet sent an NFT',
      body: 'NFT transfer'
    });
  });

  test('builds Firebase data payload values as strings', () => {
    const data = buildWalletEventNotificationData(buildEvent({
      usdValue: 3000,
      nftContractAddress: null,
      nftTokenId: 1234
    }));

    assert.deepEqual(data, {
      walletId: '4be0b63f-b584-463d-a484-ff34bd46a90b',
      walletEventId: 'd6e5a961-a769-4b35-bd19-067867dd3020',
      transactionHash: '0x1234',
      eventType: 'native_transfer',
      chainId: 'ethereum-mainnet',
      usdValue: '3000',
      usdValueStatus: 'priced_native_eth',
      nftContractAddress: '',
      nftTokenId: '1234',
      assetSymbol: 'ETH',
      amount: '1'
    });

    assert.equal(Object.values(data).every((value) => typeof value === 'string'), true);
  });

  test('builds Firebase log metadata without token or payload values', () => {
    const token = 'sensitive-fcm-token-value';
    const message = {
      token,
      notification: {
        title: 'Sensitive notification title',
        body: 'Sensitive notification body'
      },
      data: buildWalletEventNotificationData(buildEvent())
    };

    const metadata = buildSafeFirebaseLogMetadata(message);
    const serializedMetadata = JSON.stringify(metadata);

    assert.deepEqual(metadata, {
      tokenLength: token.length,
      hasNotification: true,
      dataFieldCount: Object.keys(message.data).length
    });
    assert.equal(serializedMetadata.includes(token), false);
    assert.equal(serializedMetadata.includes(message.data.walletId), false);
    assert.equal(serializedMetadata.includes(message.data.walletEventId), false);
    assert.equal(serializedMetadata.includes(message.notification.title), false);
    assert.equal(serializedMetadata.includes(message.notification.body), false);
  });
});
