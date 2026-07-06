import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import {
  claimNotificationOutboxJobs,
  getWalletEventNotificationContext,
  listActiveDeviceTokensByUserId,
  listNotificationDeliveriesByUserId,
  markNotificationOutboxFailed,
  markNotificationOutboxSent,
  scheduleNotificationOutboxRetry,
  upsertNotificationDelivery
} from './notifications.repository.js';
import { sendPushNotification } from './firebase.service.js';

const notificationsLogger = logger.child({ module: 'wallet-event-notifications' });

export const NOTIFICATION_OUTBOX_MAX_ATTEMPTS = 3;
export const NOTIFICATION_OUTBOX_BATCH_SIZE = 10;
export const NOTIFICATION_OUTBOX_POLL_INTERVAL_MS = 5 * 1000;
export const NOTIFICATION_OUTBOX_RETRY_BASE_DELAY_MS = 30 * 1000;
export const NOTIFICATION_OUTBOX_STALE_PROCESSING_MS = 5 * 60 * 1000;

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

function buildNotificationOutboxRetryDelayMs(attemptCount) {
  const normalizedAttemptCount = Math.max(1, attemptCount);
  return NOTIFICATION_OUTBOX_RETRY_BASE_DELAY_MS * normalizedAttemptCount;
}

async function deliverNotificationForDeviceToken({ event, userId, walletLabel, walletAddress, deviceToken }) {
  const message = buildNotificationMessage({
    walletLabel,
    walletAddress,
    event,
    fcmToken: deviceToken.fcmToken
  });

  try {
    notificationsLogger.info({
      walletEventId: event.id,
      deviceTokenId: deviceToken.id,
      userId,
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
      userId,
      transactionHash: event.transactionHash,
      delivered: delivery.delivered,
      skipped: delivery.skipped ?? false,
      providerMessageId: delivery.providerMessageId ?? null
    }, 'notification_deliveries upserted after Firebase send');

    return delivery;
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

    return {
      delivered: false,
      skipped: false,
      failed: true,
      errorMessage: error.message
    };
  }
}

async function processNotificationOutboxJob(job) {
  const context = await getWalletEventNotificationContext(job.walletEventId);

  if (!context) {
    await markNotificationOutboxFailed(job.id, {
      errorMessage: 'wallet_event_not_found'
    });

    notificationsLogger.error({
      outboxJobId: job.id,
      walletEventId: job.walletEventId
    }, 'Notification outbox job failed because wallet event context was missing');

    return { status: 'failed', deliveredCount: 0, failedCount: 0, skippedCount: 0 };
  }

  notificationsLogger.info({
    outboxJobId: job.id,
    walletEventId: context.id,
    walletId: context.walletId,
    userId: context.userId,
    transactionHash: context.transactionHash,
    attemptCount: job.attemptCount
  }, 'Processing notification outbox job');

  const deviceTokens = await listActiveDeviceTokensByUserId(context.userId);

  notificationsLogger.info({
    outboxJobId: job.id,
    walletEventId: context.id,
    walletId: context.walletId,
    userId: context.userId,
    deviceTokensFound: deviceTokens.length,
    deviceTokenIds: deviceTokens.map((deviceToken) => deviceToken.id)
  }, 'Resolved active device tokens for notification outbox job');

  if (deviceTokens.length === 0) {
    await markNotificationOutboxSent(job.id);

    notificationsLogger.info({
      outboxJobId: job.id,
      walletEventId: context.id,
      walletId: context.walletId,
      userId: context.userId,
      deliveredCount: 0,
      failedCount: 0,
      skippedCount: 0
    }, 'Notification outbox job sent with no active device tokens');

    return { status: 'sent', deliveredCount: 0, failedCount: 0, skippedCount: 0 };
  }

  let deliveredCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const deviceToken of deviceTokens) {
    const delivery = await deliverNotificationForDeviceToken({
      event: context,
      userId: context.userId,
      walletLabel: context.walletLabel,
      walletAddress: context.walletAddress,
      deviceToken
    });

    if (delivery.delivered) {
      deliveredCount += 1;
    } else if (delivery.skipped) {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  await markNotificationOutboxSent(job.id);

  notificationsLogger.info({
    outboxJobId: job.id,
    walletEventId: context.id,
    walletId: context.walletId,
    userId: context.userId,
    transactionHash: context.transactionHash,
    deliveredCount,
    failedCount,
    skippedCount
  }, 'Notification outbox job sent');

  return { status: 'sent', deliveredCount, failedCount, skippedCount };
}

export async function processNotificationOutboxBatch({
  limit = NOTIFICATION_OUTBOX_BATCH_SIZE,
  maxAttempts = NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
  staleProcessingMs = NOTIFICATION_OUTBOX_STALE_PROCESSING_MS
} = {}) {
  const staleProcessingBefore = new Date(Date.now() - staleProcessingMs).toISOString();
  const jobs = await claimNotificationOutboxJobs({
    limit,
    staleProcessingBefore
  });

  if (jobs.length === 0) {
    return {
      claimedCount: 0,
      sentCount: 0,
      retryScheduledCount: 0,
      failedCount: 0
    };
  }

  let sentCount = 0;
  let retryScheduledCount = 0;
  let failedCount = 0;

  for (const job of jobs) {
    try {
      const result = await processNotificationOutboxJob(job);

      if (result.status === 'sent') {
        sentCount += 1;
      } else if (result.status === 'failed') {
        failedCount += 1;
      }
    } catch (error) {
      const exhaustedAttempts = job.attemptCount >= maxAttempts;

      if (exhaustedAttempts) {
        await markNotificationOutboxFailed(job.id, {
          errorMessage: error.message
        });
        failedCount += 1;

        notificationsLogger.error({
          err: error,
          outboxJobId: job.id,
          walletEventId: job.walletEventId,
          attemptCount: job.attemptCount,
          maxAttempts
        }, 'Notification outbox job failed permanently');
      } else {
        const retryDelayMs = buildNotificationOutboxRetryDelayMs(job.attemptCount);
        const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();

        await scheduleNotificationOutboxRetry(job.id, {
          nextAttemptAt,
          errorMessage: error.message
        });
        retryScheduledCount += 1;

        notificationsLogger.warn({
          err: error,
          outboxJobId: job.id,
          walletEventId: job.walletEventId,
          attemptCount: job.attemptCount,
          nextAttemptAt,
          retryDelayMs
        }, 'Notification outbox job retry scheduled');
      }
    }
  }

  return {
    claimedCount: jobs.length,
    sentCount,
    retryScheduledCount,
    failedCount
  };
}

export async function listNotificationHistory(userId, { limit, offset }) {
  return listNotificationDeliveriesByUserId(userId, { limit, offset });
}
