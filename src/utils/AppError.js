/** An error with an HTTP status code that is safe to show to API clients. */
class AppError extends Error {
  constructor(message, statusCode = 400, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    if (details) this.details = details;
  }
}

module.exports = AppError;
