import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Decide which directory a relative target resolves against.
 *
 * The DSH host process runs with its own cwd (the profile directory), so
 * `process.cwd()` is the wrong answer for "the project I am chatting about".
 * The session's recorded directory is the right one; it is available from the
 * live agent, the workspace registry, or the session log header.
 *
 * Sources are tried in order of directness. The plugin log records which one
 * answered, so a surprising path can be explained from the log alone.
 *
 * @returns {{dir: string, source: string}}
 */
export function resolveWorkspace({ agent = null, ctx = null, env = process.env, home = os.homedir() } = {}) {
  const { session } = safeSession(agent);
  const fromSession = stringField(session?.directory) ?? stringField(session?.cwd);
  if (fromSession) return { dir: fromSession, source: 'agent session' };

  const fromEnv = stringField(env.DSH_WORKSPACE_DIR) ?? stringField(env.DSH_CWD);
  if (fromEnv) return { dir: fromEnv, source: 'environment' };

  const fromRegistry = workspaceFromRegistry(ctx);
  if (fromRegistry) return { dir: fromRegistry, source: 'workspace registry' };

  const fromLog = workspaceFromSessionLog({ env, home });
  if (fromLog) return { dir: fromLog, source: 'session log' };

  // Last resort: the host process has no session id, so ask the session logs
  // which workspace was used most recently.
  const newest = newestSessionWorkspace({ env, home });
  if (newest) return { dir: newest, source: 'newest session' };

  return { dir: process.cwd(), source: 'host cwd' };
}

/**
 * Read `agent.session` without trusting it: a host handle may expose it through
 * a getter that throws, and a read-only failure must not take down a command.
 *
 * @returns {{session: object|null, error: string|null}}
 */
export function safeSession(agent) {
  if (agent === null || agent === undefined) return { session: null, error: null };
  try {
    const session = agent.session;
    if (session === null || typeof session !== 'object') return { session: null, error: null };
    return { session, error: null };
  } catch (error) {
    return { session: null, error: String(error?.message ?? error) };
  }
}

function stringField(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Ask `ctx.workspaceRegistry` for the most recently created project directory. */
function workspaceFromRegistry(ctx) {
  const registry = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry ?? null;
  if (!registry || typeof registry.list !== 'function') return null;
  try {
    const entries = registry.list();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const dir = stringField(entry?.directory) ?? stringField(entry?.path) ?? stringField(entry?.dir);
      if (dir) return dir;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Read the `cwd` recorded in the session log header.
 *
 * Sessions live at `$DSH_HOME/sessions/<project-slug>/<sessionId>/session.v4.jsonl.zstd`;
 * only the first line (the session header) is needed, and the file is zstd-compressed.
 */
export function workspaceFromSessionLog({ env = process.env, home = os.homedir() } = {}) {
  const sessionId = stringField(env.DSH_SESSION_ID);
  const dshHome = stringField(env.DSH_HOME) ?? path.join(home, '.dsh');
  const sessionsRoot = path.join(dshHome, 'sessions');
  if (!sessionId || !fs.existsSync(sessionsRoot)) return null;

  for (const project of safeReaddir(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, project, sessionId, 'session.v4.jsonl.zstd');
    const cwd = readHeaderCwd(candidate);
    if (cwd) return cwd;
  }
  return null;
}

/**
 * Parse the header line of a session log, tolerating plain or compressed files.
 *
 * A one-shot `zstdDecompressSync` is enough here on purpose: the artifact is a
 * concatenation of per-batch frames, but the writer always emits the session header
 * as the *first* frame, so decoding frame one is decoding the header. Anything that
 * needs later frames has to walk them — a one-shot call silently returns frame one
 * and nothing else (207 bytes out of 870 KB, measured on a real session).
 */
export function readHeaderCwd(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  let text = null;
  if (typeof zlib.zstdDecompressSync === 'function') {
    try {
      text = zlib.zstdDecompressSync(raw).toString('utf8');
    } catch {
      text = null;
    }
  }
  if (text === null) text = raw.toString('utf8');
  const firstLine = text.split('\n', 1)[0];
  if (firstLine === '') return null;
  try {
    const header = JSON.parse(firstLine);
    return stringField(header?.cwd) ?? stringField(header?.directory);
  } catch {
    return null;
  }
}

/**
 * The workspace recorded by the most recently created session.
 *
 * A host-process HTTP handler cannot see the calling session, so this is the
 * best available answer for "the workspace the user is working in".
 */
export function newestSessionWorkspace({ env = process.env, home = os.homedir() } = {}) {
  const dshHome = stringField(env.DSH_HOME) ?? path.join(home, '.dsh');
  const sessionsRoot = path.join(dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  let newest = null;
  for (const project of safeReaddir(sessionsRoot)) {
    for (const sessionId of safeReaddir(path.join(sessionsRoot, project))) {
      const file = path.join(sessionsRoot, project, sessionId, 'session.v4.jsonl.zstd');
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (newest !== null && stat.mtimeMs <= newest.mtimeMs) continue;
      const cwd = readHeaderCwd(file);
      if (cwd === null) continue;
      newest = { cwd, mtimeMs: stat.mtimeMs };
    }
  }
  return newest === null ? null : newest.cwd;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
