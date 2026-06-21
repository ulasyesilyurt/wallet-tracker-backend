export class HttpError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.expose = options.expose ?? true;
  }
}
