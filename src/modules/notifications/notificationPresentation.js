export function isNftNotificationEvent(event) {
  return event.assetType === 'nft'
    || event.eventType === 'nft_transfer'
    || event.eventType === 'nft_buy'
    || event.eventType === 'nft_sell';
}

export function getNotificationPresentation(event) {
  if (isNftNotificationEvent(event)) {
    return {
      category: 'nft',
      severity: 'info'
    };
  }

  return {
    category: 'movement',
    severity: 'warning'
  };
}
