import { logger } from '../../config/logger.js';
import { captureAllWalletPortfolioSnapshots } from './performance.service.js';
import { safeErrorDetails } from '../../utils/safeError.js';

export class PortfolioSnapshotJob {
  constructor({
    intervalMs,
    captureSnapshots = captureAllWalletPortfolioSnapshots,
    now = () => new Date()
  }) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.captureSnapshots = captureSnapshots;
    this.now = now;
    this.startedAt = null;
    this.lastRunStartedAt = null;
    this.lastRunCompletedAt = null;
    this.lastRunSucceededAt = null;
    this.lastRunFailedAt = null;
    this.lastError = null;
    this.lastResult = null;
    this.logger = logger.child({ module: 'portfolio-snapshot-job' });
  }

  async runCycle() {
    if (this.running) {
      this.logger.warn('Skipping portfolio snapshot cycle because the previous run is still in progress');
      return;
    }

    this.running = true;
    this.lastRunStartedAt = this.now().toISOString();

    try {
      const result = await this.captureSnapshots();
      this.lastResult = { ...result };
      if (result.failedCount > 0) {
        this.lastRunFailedAt = this.now().toISOString();
        this.lastError = {
          errorName: 'Error',
          errorCode: 'SNAPSHOT_ITEMS_FAILED',
          status: null
        };
      } else {
        this.lastRunSucceededAt = this.now().toISOString();
      }
    } catch (error) {
      this.lastRunFailedAt = this.now().toISOString();
      this.lastError = safeErrorDetails(error);
      this.logger.error(this.lastError, 'Portfolio snapshot cycle failed');
    } finally {
      this.lastRunCompletedAt = this.now().toISOString();
      this.running = false;
    }
  }

  async start() {
    this.startedAt = this.now().toISOString();
    this.logger.info(
      { intervalMs: this.intervalMs },
      'Starting portfolio snapshot job'
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

    this.logger.info('Stopped portfolio snapshot job');
  }

  getStatus() {
    return {
      enabled: true,
      started: this.timer !== null,
      running: this.running,
      startedAt: this.startedAt,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunCompletedAt: this.lastRunCompletedAt,
      lastRunSucceededAt: this.lastRunSucceededAt,
      lastRunFailedAt: this.lastRunFailedAt,
      lastError: this.lastError && { ...this.lastError },
      lastResult: this.lastResult && { ...this.lastResult }
    };
  }
}
