import { env } from '../../config/env.js';

export function applyWalletAlertSettingsDefaults(alertSettings = null) {
  return {
    walletId: alertSettings?.walletId ?? null,
    minimumAlertUsd:
      alertSettings?.minimumAlertUsd != null
        ? Number(alertSettings.minimumAlertUsd)
        : env.DEFAULT_WALLET_ALERT_MINIMUM_USD,
    notificationsEnabled: alertSettings?.notificationsEnabled ?? true,
    notifyFungibleTransfers: alertSettings?.notifyFungibleTransfers ?? true,
    notifyIncomingTransfers: alertSettings?.notifyIncomingTransfers ?? true,
    notifyOutgoingTransfers: alertSettings?.notifyOutgoingTransfers ?? true,
    notifyNftTransfers: alertSettings?.notifyNftTransfers ?? true
  };
}

function isNftLikeEvent(event) {
  return event.assetType === 'nft' || event.eventType === 'nft_transfer' || event.eventType === 'nft_buy' || event.eventType === 'nft_sell';
}

function isFungibleTransferEvent(event) {
  return event.assetType === 'coin' || event.assetType === 'token' || event.eventType === 'native_transfer' || event.eventType === 'token_transfer';
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

  if (isFungibleTransferEvent(event) && !effectiveAlertSettings.notifyFungibleTransfers) {
    return {
      shouldEnqueue: false,
      reason: 'fungible_notifications_disabled',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  if (isFungibleTransferEvent(event) && event.direction === 'incoming' && !effectiveAlertSettings.notifyIncomingTransfers) {
    return {
      shouldEnqueue: false,
      reason: 'incoming_notifications_disabled',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  if (isFungibleTransferEvent(event) && event.direction === 'outgoing' && !effectiveAlertSettings.notifyOutgoingTransfers) {
    return {
      shouldEnqueue: false,
      reason: 'outgoing_notifications_disabled',
      minimumAlertUsd: effectiveAlertSettings.minimumAlertUsd
    };
  }

  if (
    isFungibleTransferEvent(event) &&
    event.direction !== 'incoming' &&
    event.direction !== 'outgoing' &&
    (!effectiveAlertSettings.notifyIncomingTransfers || !effectiveAlertSettings.notifyOutgoingTransfers)
  ) {
    return {
      shouldEnqueue: false,
      reason: 'transfer_direction_unavailable',
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
