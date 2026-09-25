import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NAME = 'plannotator-dsh';
export const VERSION = '0.1.0';

/** Defaults are deliberately conservative: nothing is written until a review starts. */
export function createRuntime(options = {}) {
  const home = os.homedir();
  const config = {
    binary: options.binary ?? null,
    binaryFallbacks: Array.isArray(options.binaryFallbacks) ? options.binaryFallbacks : null,
    origin: options.origin ?? 'dsh',
    gate: options.gate === true,
    openBrowser: options.openBrowser !== false,
    port: Number.isSafeInteger(options.port) && options.port > 0 ? options.port : null,
    timeoutMs: Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 900_000,
    readyTimeoutMs: Number.isSafeInteger(options.readyTimeoutMs) && options.readyTimeoutMs > 0 ? options.readyTimeoutMs : 20_000,
    autoFollowup: options.autoFollowup !== false,
    debug: options.debug === true,
    dataDir: options.dataDir ?? path.join(home, '.dsh', 'storages', NAME),
  };

  const logFile = path.join(config.dataDir, 'plannotator-dsh.log');

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    if (config.debug) process.stderr.write(`[${NAME}] ${message}\n`);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.appendFileSync(logFile, line);
    } catch {
      // Logging must never break a review.
    }
  }

  return { config, log, logFile };
}

export function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function truncate(text, limit) {
  if (typeof text !== 'string') return '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}
