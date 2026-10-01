import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { safeErrorDetails } from '../../utils/safeError.js';
import {
  claimAlchemyAddressReconciliationRows,
  completeAlchemyAddressClaim,
  getAlchemyReconciliationBacklog,
  isAlchemyAddressClaimCurrent,
  isAlchemyAddressDesired,
  releaseAlchemyAddressClaim,
  retryAlchemyAddressClaim,
  withAlchemyAddressPairLock
} from './alchemyAddressReconciliation.repository.js';
import {
  addAddressToAlchemyWebhookSync,
  listAlchemyWebhookWatchedAddresses,
  removeAddressFromAlchemyWebhookAfterDesiredCheck
} from './alchemyAddressSync.service.js';

const workerLogger = logger.child({ module: 'alchemy-address-reconciliation-worker' });

export function alchemyRetryDelayMs(attemptCount, random = Math.random) {
  const exponential = Math.min(
    env.ALCHEMY_RECONCILIATION_RETRY_MAX_MS,
    env.ALCHEMY_RECONCILIATION_RETRY_BASE_MS * (2 ** Math.min(attemptCount - 1, 16))
  );
  return Math.max(1, Math.floor(exponential * (0.75 + random() * 0.25)));
}

export function safeAlchemyReconciliationErrorCode(error) {
  if (error?.code === 'ALCHEMY_WEBHOOK_SYNC_CONFIG_INCOMPLETE') return 'CONFIG_INCOMPLETE';
  if (error?.code === 'PROVIDER_PAGE_LIMIT') return 'PROVIDER_PAGE_LIMIT';
  if (error?.code === 'PROVIDER_INVALID_RESPONSE') return 'PROVIDER_INVALID_RESPONSE';
  if (error?.code === 'ALCHEMY_OBSERVED_MISMATCH') return 'OBSERVED_MISMATCH';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'PROVIDER_TIMEOUT';
  if (Number.isInteger(error?.status)) {
    if (error.status === 429) return 'PROVIDER_RATE_LIMIT';
    return error.status >= 500 ? 'PROVIDER_HTTP_5XX' : 'PROVIDER_HTTP_4XX';
  }
  return 'RECONCILIATION_ERROR';
}

export async function reconcileClaimedAlchemyAddress(claim, {
  signal,
  isClaimCurrent = isAlchemyAddressClaimCurrent,
  isDesired = isAlchemyAddressDesired,
  listWatched = listAlchemyWebhookWatchedAddresses,
  addAddress = addAddressToAlchemyWebhookSync,
  removeAddress = removeAddressFromAlchemyWebhookAfterDesiredCheck,
  completeClaim = completeAlchemyAddressClaim,
  releaseClaim = releaseAlchemyAddressClaim,
  withPairLock = withAlchemyAddressPairLock
} = {}) {
  return withPairLock({ chainId: claim.chainId, address: claim.address }, async (client) => {
    const dbQuery = client.query.bind(client);
    if (!await isClaimCurrent(claim, dbQuery)) return 'superseded';

    const desired = await isDesired(claim.chainId, claim.address, dbQuery);
    let observed = (await listWatched(claim.chainId, { signal })).includes(claim.address);
    const action = desired === observed ? 'none' : desired ? 'add' : 'remove';

    if (desired !== observed) {
      if (desired) {
        await addAddress({ chainId: claim.chainId, address: claim.address, reason: 'durable_reconciliation', signal });
      } else {
        await removeAddress({ chainId: claim.chainId, address: claim.address, reason: 'durable_reconciliation', signal });
      }

      // A timeout can occur after Alchemy applies a PATCH. Confirm the actual state.
      observed = (await listWatched(claim.chainId, { signal })).includes(claim.address);
      if (observed !== desired) {
        const error = new Error('Alchemy observed state did not converge');
        error.code = 'ALCHEMY_OBSERVED_MISMATCH';
        throw error;
      }
    }

    // The pair lock prevents participating wallet mutations until completion.
    // Recheck anyway so an uncoordinated change cannot complete stale work.
    if (observed !== await isDesired(claim.chainId, claim.address, dbQuery)) {
      await releaseClaim(claim, dbQuery);
      return 'requeued';
    }

    if (!await completeClaim(claim, observed, dbQuery)) {
      await releaseClaim(claim, dbQuery);
      return 'superseded';
    }

    workerLogger.info({ chainId: claim.chainId, action }, 'Alchemy address state converged');
    return 'converged';
  });
}

export async function processAlchemyReconciliationBatch({
  signal,
  limit = env.ALCHEMY_RECONCILIATION_BATCH_SIZE,
  leaseMs = env.ALCHEMY_RECONCILIATION_LEASE_MS,
  claimRows = claimAlchemyAddressReconciliationRows,
  reconcileClaim = reconcileClaimedAlchemyAddress,
  retryClaim = retryAlchemyAddressClaim,
  backlog = getAlchemyReconciliationBacklog,
  random = Math.random
} = {}) {
  const result = {
    claimedCount: 0,
    staleLeaseCount: 0,
    convergedCount: 0,
    retryScheduledCount: 0,
    supersededCount: 0
  };

  // Claim one at a time so later rows do not expire while a prior provider call runs.
  for (let processed = 0; processed < limit; processed += 1) {
    if (signal?.aborted) break;
    const [claim] = await claimRows({ limit: 1, leaseMs });
    if (!claim) break;
    result.claimedCount += 1;
    if (claim.stale) result.staleLeaseCount += 1;
    try {
      const outcome = await reconcileClaim(claim, { signal });
      if (outcome === 'converged') result.convergedCount += 1;
      else result.supersededCount += 1;
    } catch (error) {
      const errorCode = safeAlchemyReconciliationErrorCode(error);
      const delayMs = alchemyRetryDelayMs(Number(claim.attemptCount) + 1, random);
      const scheduled = await retryClaim(claim, { delayMs, errorCode });
      if (scheduled) result.retryScheduledCount += 1;
      else result.supersededCount += 1;
      workerLogger.warn({
        chainId: claim.chainId,
        errorCode,
        retryScheduled: scheduled,
        attemptCount: Number(claim.attemptCount) + 1,
        delayMs,
        ...safeErrorDetails(error)
      }, 'Alchemy address reconciliation failed');
    }
  }

  const pending = await backlog();
  const log = result.claimedCount > 0 || pending.count > 0 ? workerLogger.info : workerLogger.debug;
  log.call(workerLogger, { ...result, backlogCount: pending.count, oldestPendingAgeSeconds: pending.oldestAgeSeconds },
    'Alchemy address reconciliation batch completed');
  return { ...result, backlog: pending };
}
