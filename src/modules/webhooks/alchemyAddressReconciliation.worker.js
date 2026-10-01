import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { safeErrorDetails } from '../../utils/safeError.js';
import { processAlchemyReconciliationBatch } from './alchemyAddressReconciliation.service.js';

export class AlchemyAddressReconciliationWorker {
  constructor({
    intervalMs = env.ALCHEMY_RECONCILIATION_POLL_INTERVAL_MS,
    batchSize = env.ALCHEMY_RECONCILIATION_BATCH_SIZE,
    processBatch = processAlchemyReconciliationBatch
  } = {}) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.processBatch = processBatch;
    this.timer = null;
    this.activeCycle = null;
    this.abortController = null;
    this.stopping = false;
    this.logger = logger.child({ module: 'alchemy-address-reconciliation-worker' });
  }

  async runCycle() {
    if (this.stopping || this.activeCycle) return;
    this.abortController = new AbortController();
    this.activeCycle = (async () => {
      try {
        return await this.processBatch({ limit: this.batchSize, signal: this.abortController.signal });
      } catch (error) {
        this.logger.error(safeErrorDetails(error), 'Alchemy reconciliation cycle failed');
        return null;
      }
    })();

    try {
      return await this.activeCycle;
    } finally {
      this.activeCycle = null;
      this.abortController = null;
    }
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.runCycle(); }, this.intervalMs);
    this.logger.info({ intervalMs: this.intervalMs, batchSize: this.batchSize },
      'Starting Alchemy address reconciliation worker');
    void this.runCycle();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abortController?.abort();
    if (this.activeCycle) await this.activeCycle;
    this.logger.info('Stopped Alchemy address reconciliation worker');
  }
}
