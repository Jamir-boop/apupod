import { createHash, timingSafeEqual } from "node:crypto";
import {
  open,
  readFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const FFMPEG_TIMEOUT_MS = 900_000;
const PROCESS_KILL_SIGNAL = "SIGKILL";

// Names whose process.env value came from the config-dir .env (loaded or saved through Settings).
// A replacement daemon must re-read the file instead of inheriting these values.
export const envFileNames = new Set();

export function environmentWithoutEnvFile(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !envFileNames.has(name)));
}

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

const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const ID_RE = /^[a-zA-Z0-9_-]+$/;

export function validateId(id, label) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw badRequest(`${label} ID is invalid.`);
}

export function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${label} is required.`);
}

export function validateNumber(value, fallback, minimum, maximum, label) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw badRequest(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return number;
}

export function validateOptionalNumber(value, minimum, maximum, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw badRequest(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return number;
}

export function validateOptionalInteger(value, minimum, maximum, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw badRequest(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

export function assertSafeId(id) {
  if (!ID_RE.test(String(id))) throw badRequest("Invalid identifier.");
}

export async function readJsonBody(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = badRequest("Content-Type must be application/json.");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw badRequest("Request body exceeds 4 MiB limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
}

export async function readOptionalJsonBody(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (!length && !req.headers["content-type"]) return {};
  return readJsonBody(req);
}

export function assertLocalRequest(req, method) {
  const remoteAddress = String(req.socket?.remoteAddress || "").toLowerCase();
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
    const error = new Error("Local requests only.");
    error.statusCode = 403;
    throw error;
  }
  const hostHeader = String(req.headers.host || "").toLowerCase();
  const host = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    const error = new Error("Local requests only.");
    error.statusCode = 403;
    throw error;
  }
  const origin = req.headers.origin;
  if (method !== "GET" && method !== "HEAD" && origin) {
    let originValue = "";
    try {
      originValue = new URL(origin).origin.toLowerCase();
    } catch {
      originValue = "invalid";
    }
    if (originValue !== `http://${hostHeader}`) {
      const error = new Error("Cross-origin writes are forbidden.");
      error.statusCode = 403;
      throw error;
    }
  }
}

export function authorizeRequest(req, res, context) {
  const expected = Buffer.from(`Bearer ${context.mcpToken}`);
  const given = Buffer.from(String(req.headers.authorization || ""));
  if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  res.setHeader("WWW-Authenticate", 'Bearer realm="apupod"');
  sendJson(res, 401, { error: "Sign in to apupod: run `apupod open`, or ask your agent to open the apupod UI." });
  return false;
}

export function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export async function sendFile(req, res, path, contentType, contentSecurityPolicy = "") {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (error.code === "ENOENT") throw notFound("File does not exist.");
    throw error;
  }
  try {
    const info = await file.stat();
    const range = parseByteRange(req.headers.range, info.size);
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": contentType.startsWith("audio/") ? "no-store" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      // Audio is cross-origin so MCP App widgets (sandboxed iframes on the host's origin) can play it; URLs carry unguessable IDs.
      "Cross-Origin-Resource-Policy": contentType.startsWith("audio/") ? "cross-origin" : "same-origin",
      "Accept-Ranges": "bytes",
    };
    if (contentType.startsWith("text/html")) {
      headers["Content-Security-Policy"] = contentSecurityPolicy;
      headers["X-Frame-Options"] = "DENY";
      headers["Referrer-Policy"] = "no-referrer";
    }
    if (!range) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}`, "Content-Length": 0 });
      res.end();
      return;
    }
    const length = range.end - range.start + 1;
    if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.size}`;
    res.writeHead(range.partial ? 206 : 200, { ...headers, "Content-Length": length });
    if (length === 0) {
      res.end();
      return;
    }
    const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: true });
    file = null;
    await pipeline(stream, res);
  } finally {
    await file?.close();
  }
}

export async function htmlContentSecurityPolicy(path) {
  const html = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
  const hashes = (tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map((match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  const scripts = hashes("script");
  const styles = hashes("style");
  return `default-src 'none'; base-uri 'none'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; script-src ${scripts.join(" ") || "'none'"}; style-src ${styles.join(" ") || "'none'"}; frame-ancestors 'none'; form-action 'self'`;
}

function parseByteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

export async function runProcess(command, args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Not spawn({ timeout }): a spawn that fails with ENOENT never emits "exit", so Node keeps its
    // own timer armed for the whole timeout and pins the event loop.
    const timer = setTimeout(() => { timedOut = true; child.kill(PROCESS_KILL_SIGNAL); }, timeoutMs).unref();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs} ms and was stopped with ${signal || PROCESS_KILL_SIGNAL}: ${stderr.trim()}`));
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
