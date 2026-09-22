import { safeErrorDetails } from '../../utils/safeError.js';

const createSignalState = () => ({
  successCount: 0,
  rejectionCount: 0,
  failureCount: 0,
  lastSucceededAt: null,
  lastRejectedAt: null,
  lastFailedAt: null,
  lastFailure: null
});

const webhookState = createSignalState();
const alchemySyncState = createSignalState();

function nowIso() {
  return new Date().toISOString();
}

export function recordWebhookSuccess() {
  webhookState.successCount += 1;
  webhookState.lastSucceededAt = nowIso();
}

export function recordWebhookRejection(error) {
  webhookState.rejectionCount += 1;
  webhookState.lastRejectedAt = nowIso();
  webhookState.lastFailure = safeErrorDetails(error);
}

export function recordWebhookFailure(error) {
  webhookState.failureCount += 1;
  webhookState.lastFailedAt = nowIso();
  webhookState.lastFailure = safeErrorDetails(error);
}

export function recordAlchemySyncSuccess() {
  alchemySyncState.successCount += 1;
  alchemySyncState.lastSucceededAt = nowIso();
}

export function recordAlchemySyncFailure(error) {
  alchemySyncState.failureCount += 1;
  alchemySyncState.lastFailedAt = nowIso();
  alchemySyncState.lastFailure = safeErrorDetails(error);
}

export function getOperationalSignalState() {
  return {
    webhook: { ...webhookState, lastFailure: webhookState.lastFailure && { ...webhookState.lastFailure } },
    alchemySync: { ...alchemySyncState, lastFailure: alchemySyncState.lastFailure && { ...alchemySyncState.lastFailure } }
  };
}

export function resetOperationalSignalStateForTests() {
  Object.assign(webhookState, createSignalState());
  Object.assign(alchemySyncState, createSignalState());
}
