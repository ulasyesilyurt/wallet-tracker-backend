import { logger } from '../../config/logger.js';
import {
  NOTIFICATION_OUTBOX_BATCH_SIZE,
  NOTIFICATION_OUTBOX_POLL_INTERVAL_MS,
  processNotificationOutboxBatch
} from './notifications.service.js';

export class NotificationOutboxWorker {
  constructor({
    intervalMs = NOTIFICATION_OUTBOX_POLL_INTERVAL_MS,
    batchSize = NOTIFICATION_OUTBOX_BATCH_SIZE
  } = {}) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.timer = null;
    this.running = false;
    this.logger = logger.child({ module: 'notification-outbox-worker' });
  }

  async runCycle() {
    if (this.running) {
      this.logger.warn('Skipping notification outbox cycle because the previous run is still in progress');
      return;
    }

    this.running = true;

    try {
      const result = await processNotificationOutboxBatch({ limit: this.batchSize });

      if (result.claimedCount > 0) {
        this.logger.info(
          {
            claimedCount: result.claimedCount,
            sentCount: result.sentCount,
            retryScheduledCount: result.retryScheduledCount,
            failedCount: result.failedCount
          },
          'Processed notification outbox batch'
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Notification outbox cycle failed');
    } finally {
      this.running = false;
    }
  }

  async start() {
    this.logger.info(
      {
        intervalMs: this.intervalMs,
        batchSize: this.batchSize
      },
      'Starting notification outbox worker'
    );

    await this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Stopped notification outbox worker');
  }
}
