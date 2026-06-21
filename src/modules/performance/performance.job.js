import { logger } from '../../config/logger.js';
import { captureAllWalletPortfolioSnapshots } from './performance.service.js';

export class PortfolioSnapshotJob {
  constructor({ intervalMs }) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.logger = logger.child({ module: 'portfolio-snapshot-job' });
  }

  async runCycle() {
    if (this.running) {
      this.logger.warn('Skipping portfolio snapshot cycle because the previous run is still in progress');
      return;
    }

    this.running = true;

    try {
      await captureAllWalletPortfolioSnapshots();
    } catch (error) {
      this.logger.error({ err: error }, 'Portfolio snapshot cycle failed');
    } finally {
      this.running = false;
    }
  }

  async start() {
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
}
