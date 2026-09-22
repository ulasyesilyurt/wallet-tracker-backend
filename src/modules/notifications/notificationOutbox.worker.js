import { logger } from '../../config/logger.js';
import {
  NOTIFICATION_OUTBOX_BATCH_SIZE,
  NOTIFICATION_OUTBOX_POLL_INTERVAL_MS,
  processNotificationOutboxBatch
} from './notifications.service.js';
import { safeErrorDetails } from '../../utils/safeError.js';

export class NotificationOutboxWorker {
  constructor({
    intervalMs = NOTIFICATION_OUTBOX_POLL_INTERVAL_MS,
    batchSize = NOTIFICATION_OUTBOX_BATCH_SIZE,
    processBatch = processNotificationOutboxBatch,
    now = () => new Date()
  } = {}) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.timer = null;
    this.running = false;
    this.processBatch = processBatch;
    this.now = now;
    this.startedAt = null;
    this.lastCycleStartedAt = null;
    this.lastCycleCompletedAt = null;
    this.lastCycleSucceededAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.lastResult = null;
    this.logger = logger.child({ module: 'notification-outbox-worker' });
  }

  async runCycle() {
    if (this.running) {
      this.logger.warn('Skipping notification outbox cycle because the previous run is still in progress');
      return;
    }

    this.running = true;
    this.lastCycleStartedAt = this.now().toISOString();

    try {
      const result = await this.processBatch({ limit: this.batchSize });
      this.lastCycleSucceededAt = this.now().toISOString();
      this.lastResult = { ...result };

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
      this.lastErrorAt = this.now().toISOString();
      this.lastError = safeErrorDetails(error);
      this.logger.error(this.lastError, 'Notification outbox cycle failed');
    } finally {
      this.lastCycleCompletedAt = this.now().toISOString();
      this.running = false;
    }
  }

  async start() {
    this.startedAt = this.now().toISOString();
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

  isStarted() {
    return this.timer !== null;
  }

  getStatus() {
    return {
      started: this.isStarted(),
      running: this.running,
      startedAt: this.startedAt,
      lastCycleStartedAt: this.lastCycleStartedAt,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      lastCycleSucceededAt: this.lastCycleSucceededAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError && { ...this.lastError },
      lastResult: this.lastResult && { ...this.lastResult }
    };
  }
}
