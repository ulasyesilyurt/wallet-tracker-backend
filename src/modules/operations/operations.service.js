import { checkDatabaseReadiness } from '../../db/readiness.js';
import { getOperationalSignalState } from './operationalState.js';
import { getNotificationOutboxOperationalSummary } from './operations.repository.js';

export async function buildOperationalStatus({
  checkDatabase = checkDatabaseReadiness,
  getOutboxSummary = getNotificationOutboxOperationalSummary,
  getWorkerStatus = () => ({ started: false }),
  getSnapshotStatus = () => ({ enabled: false }),
  getProcessInfo = () => ({})
} = {}) {
  let databaseAvailable = false;
  try {
    databaseAvailable = await checkDatabase();
  } catch {
    databaseAvailable = false;
  }
  let outbox;

  if (databaseAvailable) {
    try {
      outbox = { available: true, ...await getOutboxSummary() };
    } catch {
      outbox = { available: false };
    }
  } else {
    outbox = { available: false };
  }

  const worker = getWorkerStatus();
  const snapshot = getSnapshotStatus();
  const signals = getOperationalSignalState();
  const status = databaseAvailable && outbox.available && worker.started ? 'ok' : 'degraded';

  return {
    status,
    timestamp: new Date().toISOString(),
    process: getProcessInfo(),
    database: { available: databaseAvailable },
    notificationOutbox: outbox,
    notificationWorker: worker,
    webhook: signals.webhook,
    alchemySync: signals.alchemySync,
    portfolioSnapshot: snapshot
  };
}
