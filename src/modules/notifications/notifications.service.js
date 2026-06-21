import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import {
  listActiveDeviceTokensByUserId,
  getWalletNotificationTarget,
  listNotificationDeliveriesByUserId,
  upsertNotificationDelivery
} from './notifications.repository.js';
import { sendPushNotification } from './firebase.service.js';

const notificationsLogger = logger.child({ module: 'wallet-event-notifications' });

function toEventTypeLabel(eventType) {
  switch (eventType) {
    case 'native_transfer':
      return 'Native transfer';
    case 'token_transfer':
      return 'Token transfer';
    case 'nft_transfer':
      return 'NFT transfer';
    case 'nft_buy':
      return 'NFT buy';
    case 'nft_sell':
      return 'NFT sell';
    default:
      return eventType;
  }
}

function buildNotificationBody({ walletLabel, walletAddress, event }) {
  const walletDisplay = walletLabel || walletAddress;
  const assetDisplay = event.assetSymbol || event.assetName || (event.assetType === 'nft' ? 'NFT' : 'asset');
  const amountDisplay = event.amount ? `${event.amount} ` : '';

  return `${walletDisplay}: ${toEventTypeLabel(event.eventType)}${assetDisplay ? ` • ${amountDisplay}${assetDisplay}` : ''}`;
}

function buildNotificationMessage({ walletLabel, walletAddress, event, fcmToken }) {
  const title = walletLabel || 'Tracked wallet activity';
  const body = buildNotificationBody({ walletLabel, walletAddress, event });

  return {
    token: fcmToken,
    notification: {
      title,
      body
    },
    android: {
      priority: 'high',
      notification: {
        channelId: env.FIREBASE_ANDROID_NOTIFICATION_CHANNEL_ID,
        title,
        body,
        sound: 'default',
        defaultSound: true,
        notificationPriority: 'PRIORITY_HIGH',
        visibility: 'PUBLIC'
      }
    },
    data: {
      walletId: String(event.walletId),
      walletEventId: String(event.id),
      transactionHash: event.transactionHash ? String(event.transactionHash) : '',
      eventType: String(event.eventType),
      chainId: event.chainId ? String(event.chainId) : ''
    }
  };
}

export async function notifyWalletEvent(event) {
  const target = await getWalletNotificationTarget(event.walletId);

  if (!target) {
    notificationsLogger.warn({ walletId: event.walletId, walletEventId: event.id }, 'Wallet notification target not found');
    return;
  }

  notificationsLogger.info({
    walletEventId: event.id,
    walletId: event.walletId,
    userId: target.user_id,
    walletLabel: target.wallet_label,
    transactionHash: event.transactionHash
  }, 'Notification dispatch started for wallet event');

  const deviceTokens = await listActiveDeviceTokensByUserId(target.user_id);

  notificationsLogger.info({
    walletEventId: event.id,
    walletId: event.walletId,
    userId: target.user_id,
    deviceTokensFound: deviceTokens.length,
    deviceTokenIds: deviceTokens.map((deviceToken) => deviceToken.id)
  }, 'Resolved active device tokens for wallet event notification');

  if (deviceTokens.length === 0) {
    notificationsLogger.info({
      walletEventId: event.id,
      walletId: event.walletId,
      userId: target.user_id
    }, 'No active device tokens available for wallet event notification');
    return;
  }

  for (const deviceToken of deviceTokens) {
    const message = buildNotificationMessage({
      walletLabel: target.wallet_label,
      walletAddress: target.wallet_address,
      event,
      fcmToken: deviceToken.fcmToken
    });

    try {
      notificationsLogger.info({
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        userId: target.user_id,
        transactionHash: event.transactionHash,
        deliveryStatus: 'pending',
        firebasePayloadPreview: {
          hasNotification: true,
          androidPriority: message.android?.priority,
          androidChannelId: message.android?.notification?.channelId,
          notificationTitle: message.notification?.title,
          notificationBody: message.notification?.body,
          dataKeys: Object.keys(message.data ?? {})
        }
      }, 'Attempting notification_deliveries upsert before Firebase send');

      await upsertNotificationDelivery({
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        status: 'pending'
      });

      const delivery = await sendPushNotification(message);

      await upsertNotificationDelivery({
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        status: delivery.delivered ? 'delivered' : 'failed',
        providerMessageId: delivery.providerMessageId ?? null,
        errorMessage: delivery.skipped ? delivery.reason : null
      });

      notificationsLogger.info({
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        userId: target.user_id,
        transactionHash: event.transactionHash,
        delivered: delivery.delivered,
        skipped: delivery.skipped ?? false,
        providerMessageId: delivery.providerMessageId ?? null
      }, 'notification_deliveries upserted after Firebase send');
    } catch (error) {
      await upsertNotificationDelivery({
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        status: 'failed',
        errorMessage: error.message
      });

      notificationsLogger.error({
        err: error,
        walletEventId: event.id,
        walletId: event.walletId,
        deviceTokenId: deviceToken.id,
        transactionHash: event.transactionHash
      }, 'Failed to deliver wallet event push notification');
    }
  }
}

export async function listNotificationHistory(userId, { limit, offset }) {
  return listNotificationDeliveriesByUserId(userId, { limit, offset });
}
