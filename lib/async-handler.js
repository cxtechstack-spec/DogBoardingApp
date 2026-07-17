// Wraps an async Express route handler so a rejected promise reaches Express's
// error middleware instead of becoming an unhandled rejection that crashes the process.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
