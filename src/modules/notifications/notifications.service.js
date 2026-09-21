import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import {
  claimNotificationOutboxJobs,
  countUnreadNotificationsByUserId,
  ensureNotificationForWalletEvent,
  getWalletEventNotificationContext,
  listActiveDeviceTokensByUserId,
  listNotificationDeliveryStates,
  listNotificationsByUserId,
  markAllNotificationsReadByUserId,
  markNotificationReadById,
  markNotificationOutboxFailed,
  markNotificationOutboxSent,
  recordInvalidTokenDelivery,
  scheduleNotificationOutboxRetry,
  upsertNotificationDelivery
} from './notifications.repository.js';
import { sendPushNotification } from './firebase.service.js';
import { classifyFirebaseDeliveryError } from './firebaseDeliveryErrors.js';
import {
  buildWalletEventNotificationCopy,
  buildWalletEventNotificationData
} from './notificationCopy.js';
import { buildSafeFirebaseLogMetadata } from './firebaseLogMetadata.js';
import { getNotificationPresentation } from './notificationPresentation.js';
import { HttpError } from '../../utils/httpError.js';

const notificationsLogger = logger.child({ module: 'wallet-event-notifications' });

export const NOTIFICATION_OUTBOX_MAX_ATTEMPTS = 3;
export const NOTIFICATION_OUTBOX_BATCH_SIZE = 10;
export const NOTIFICATION_OUTBOX_POLL_INTERVAL_MS = 5 * 1000;
export const NOTIFICATION_OUTBOX_RETRY_BASE_DELAY_MS = 30 * 1000;
export const NOTIFICATION_OUTBOX_STALE_PROCESSING_MS = 5 * 60 * 1000;

function buildNotificationMessage({ walletLabel, event, fcmToken }) {
  const { title, body } = buildWalletEventNotificationCopy({ walletLabel, event });
  const { category, severity } = getNotificationPresentation(event);

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
      ...buildWalletEventNotificationData(event),
      type: String(event.eventType),
      category,
      severity
    }
  };
}

function buildNotificationOutboxRetryDelayMs(attemptCount) {
  const normalizedAttemptCount = Math.max(1, attemptCount);
  return NOTIFICATION_OUTBOX_RETRY_BASE_DELAY_MS * normalizedAttemptCount;
}

async function deliverNotificationForDeviceToken({ notificationId, event, userId, walletLabel, deviceToken, sendPush }) {
  const message = buildNotificationMessage({
    walletLabel,
    event,
    fcmToken: deviceToken.fcmToken
  });

  notificationsLogger.info({
    deviceTokenId: deviceToken.id,
    userId,
    deliveryStatus: 'pending',
    ...buildSafeFirebaseLogMetadata(message),
    androidPriority: message.android?.priority,
    androidChannelId: message.android?.notification?.channelId
  }, 'Attempting notification_deliveries upsert before Firebase send');

  const reserved = await upsertNotificationDelivery({
    notificationId,
    walletEventId: event.id,
    deviceTokenId: deviceToken.id,
    status: 'pending',
    retryable: true
  });

  if (!reserved) {
    return { delivered: true, alreadyDelivered: true, retryable: false };
  }

  let delivery;

  try {
    delivery = await sendPush(message);
  } catch (error) {
    const failure = classifyFirebaseDeliveryError(error);

    if (failure.kind === 'invalid_token') {
      await recordInvalidTokenDelivery({
        notificationId,
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        userId,
        fcmToken: deviceToken.fcmToken,
        tokenUpdatedAt: deviceToken.tokenUpdatedAt,
        errorMessage: failure.reason
      });
    } else {
      await upsertNotificationDelivery({
        notificationId,
        walletEventId: event.id,
        deviceTokenId: deviceToken.id,
        status: 'failed',
        errorMessage: failure.reason,
        retryable: failure.kind === 'transient'
      });
    }

    notificationsLogger.warn({
      deviceTokenId: deviceToken.id,
      userId,
      failureKind: failure.kind,
      errorCode: failure.reason
    }, 'Firebase push delivery failed');

    return {
      delivered: false,
      skipped: false,
      retryable: failure.kind === 'transient',
      invalidToken: failure.kind === 'invalid_token'
    };
  }

  if (delivery.delivered) {
    await upsertNotificationDelivery({
      notificationId,
      walletEventId: event.id,
      deviceTokenId: deviceToken.id,
      status: 'delivered',
      providerMessageId: delivery.providerMessageId ?? null,
      retryable: false
    });

    notificationsLogger.info({
      deviceTokenId: deviceToken.id,
      userId,
      delivered: true,
      providerMessageId: delivery.providerMessageId ?? null
    }, 'Firebase push delivery recorded');

    return { delivered: true, skipped: false, retryable: false };
  }

  const retryable = !delivery.skipped;
  await upsertNotificationDelivery({
    notificationId,
    walletEventId: event.id,
    deviceTokenId: deviceToken.id,
    status: 'failed',
    errorMessage: delivery.reason ?? 'firebase_send_unconfirmed',
    retryable
  });

  return { delivered: false, skipped: Boolean(delivery.skipped), retryable };
}

export async function processNotificationOutboxJob(job, { sendPush = sendPushNotification } = {}) {
  const context = await getWalletEventNotificationContext(job.walletEventId);

  if (!context) {
    await markNotificationOutboxFailed(job.id, {
      errorMessage: 'wallet_event_not_found'
    });

    notificationsLogger.error({
      outboxJobId: job.id
    }, 'Notification outbox job failed because wallet event context was missing');

    return { status: 'failed', deliveredCount: 0, failedCount: 0, skippedCount: 0 };
  }

  notificationsLogger.info({
    outboxJobId: job.id,
    userId: context.userId,
    attemptCount: job.attemptCount
  }, 'Processing notification outbox job');

  const notificationId = await ensureNotificationForWalletEvent(context.id);
  const deviceTokens = await listActiveDeviceTokensByUserId(context.userId);
  const deliveryStates = await listNotificationDeliveryStates(notificationId);
  const deliveryStateByDeviceId = new Map(deliveryStates.map((row) => [row.deviceTokenId, row]));

  notificationsLogger.info({
    outboxJobId: job.id,
    userId: context.userId,
    deviceTokensFound: deviceTokens.length
  }, 'Resolved active device tokens for notification outbox job');

  if (deviceTokens.length === 0) {
    await markNotificationOutboxSent(job.id);

    notificationsLogger.info({
      outboxJobId: job.id,
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
  let retryableCount = 0;

  for (const deviceToken of deviceTokens) {
    const previous = deliveryStateByDeviceId.get(deviceToken.id);

    if (previous?.status === 'delivered' ||
        (previous?.status === 'failed' && !previous.retryable)) {
      skippedCount += 1;
      continue;
    }

    const delivery = await deliverNotificationForDeviceToken({
      notificationId,
      event: context,
      userId: context.userId,
      walletLabel: context.walletLabel,
      deviceToken,
      sendPush
    });

    if (delivery.delivered) {
      deliveredCount += 1;
    } else if (delivery.skipped) {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }

    if (delivery.retryable) {
      retryableCount += 1;
    }
  }

  if (retryableCount > 0) {
    const error = new Error('retryable_notification_delivery_failure');
    error.code = 'FCM_DELIVERY_RETRYABLE';
    throw error;
  }

  await markNotificationOutboxSent(job.id);

  notificationsLogger.info({
    outboxJobId: job.id,
    userId: context.userId,
    deliveredCount,
    failedCount,
    skippedCount
  }, 'Notification outbox job sent');

  return { status: 'sent', deliveredCount, failedCount, skippedCount };
}

export async function processNotificationOutboxBatch({
  limit = NOTIFICATION_OUTBOX_BATCH_SIZE,
  maxAttempts = NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
  staleProcessingMs = NOTIFICATION_OUTBOX_STALE_PROCESSING_MS,
  outboxId = null,
  sendPush = sendPushNotification
} = {}) {
  const staleProcessingBefore = new Date(Date.now() - staleProcessingMs).toISOString();
  const jobs = await claimNotificationOutboxJobs({
    limit,
    staleProcessingBefore,
    outboxId
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
      const result = await processNotificationOutboxJob(job, { sendPush });

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
          outboxJobId: job.id,
          errorName: error.name,
          errorCode: error.code ?? null,
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
          outboxJobId: job.id,
          errorName: error.name,
          errorCode: error.code ?? null,
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
  const result = await listNotificationsByUserId(userId, { limit, offset });

  return {
    ...result,
    items: result.items.map((item) => {
      const event = item.walletEvent;
      const { title, body } = buildWalletEventNotificationCopy({
        walletLabel: event.walletLabel,
        event
      });
      const { category, severity } = getNotificationPresentation(event);

      return {
        ...item,
        walletId: event.walletId,
        chainId: event.chainId,
        type: event.eventType,
        category,
        severity,
        title,
        body,
        relatedEventId: event.id,
        transactionHash: event.transactionHash
      };
    })
  };
}

export async function getUnreadNotificationCount(userId) {
  return countUnreadNotificationsByUserId(userId);
}

export async function markNotificationRead(notificationId, userId) {
  const notification = await markNotificationReadById(notificationId, userId);

  if (!notification) {
    throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
  }

  return {
    ...notification,
    isRead: true
  };
}

export async function markAllNotificationsRead(userId) {
  return markAllNotificationsReadByUserId(userId);
}
