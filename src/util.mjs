export function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeDelivery(value) {
  return oneLine(value).replace(/[\[\]]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export const badRequest = (message) => httpError(400, message);
export const conflict = (message) => httpError(409, message);
export const notFound = (message) => httpError(404, message);
export const serviceUnavailable = (message) => httpError(503, message);
