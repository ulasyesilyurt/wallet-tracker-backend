import { env } from '../../config/env.js';

export function applyWalletAlertSettingsDefaults(alertSettings = null) {
  return {
    walletId: alertSettings?.walletId ?? null,
    minimumAlertUsd:
      alertSettings?.minimumAlertUsd != null
        ? Number(alertSettings.minimumAlertUsd)
        : env.DEFAULT_WALLET_ALERT_MINIMUM_USD,
    notificationsEnabled: alertSettings?.notificationsEnabled ?? true,
    notifyNftTransfers: alertSettings?.notifyNftTransfers ?? true
  };
}

function isNftLikeEvent(event) {
  return event.assetType === 'nft' || event.eventType === 'nft_transfer' || event.eventType === 'nft_buy' || event.eventType === 'nft_sell';
}

export function shouldEnqueueNotificationForWalletEvent({ event, alertSettings }) {
  const effectiveAlertSettings = applyWalletAlertSettingsDefaults(alertSettings);

  if (!effectiveAlertSettings.notificationsEnabled) {
    return {
      shouldEnqueue: false,
      reason: 'notifications_disabled',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  if (isNftLikeEvent(event)) {
    return {
      shouldEnqueue: effectiveAlertSettings.notifyNftTransfers,
      reason: effectiveAlertSettings.notifyNftTransfers ? 'nft_notifications_enabled' : 'nft_notifications_disabled',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  const usdValue = event.usdValue != null ? Number(event.usdValue) : null;

  if (!Number.isFinite(usdValue)) {
    return {
      shouldEnqueue: false,
      reason: 'usd_value_unavailable',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  if (usdValue < effectiveAlertSettings.minimumAlertUsd) {
    return {
      shouldEnqueue: false,
      reason: 'below_minimum_alert_usd',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  return {
    shouldEnqueue: true,
    reason: 'threshold_passed',
    minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
  };
}
