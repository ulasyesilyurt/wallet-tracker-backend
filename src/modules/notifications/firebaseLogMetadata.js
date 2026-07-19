export function buildSafeFirebaseLogMetadata(message) {
  return {
    tokenLength: typeof message?.token === 'string' ? message.token.length : 0,
    hasNotification: Boolean(message?.notification),
    dataFieldCount: Object.keys(message?.data ?? {}).length
  };
}
