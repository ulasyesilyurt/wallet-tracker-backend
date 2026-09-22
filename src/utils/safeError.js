const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]*Error$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_-]{1,64}$/;

export function safeErrorDetails(error) {
  const rawName = typeof error?.name === 'string' ? error.name : '';
  const rawCode = error?.code == null ? '' : String(error.code);
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? error.status
    : null;

  return {
    errorName: SAFE_ERROR_NAME.test(rawName) ? rawName : 'Error',
    errorCode: SAFE_ERROR_CODE.test(rawCode) ? rawCode : null,
    status
  };
}
