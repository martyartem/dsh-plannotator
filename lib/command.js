import path from 'node:path';

import { expandHome, pathExists } from './binary.js';

/**
 * The command surface is deliberately one command: review a target.
 *
 * Everything the plugin used to offer through the slash command — the `docs`
 * shortcut, `last`, `review` (git working tree / PR), `archive`, the `diag`
 * reports and every flag — is gone. A review starts either from the document
 * preview's Review button or from this command, and neither offers options:
 * `gate`, `port`, `openBrowser` and the timeout come from the plugin config.
 */
export const HELP_TEXT = [
  '/plannotator — review a file, a folder or a web page in the browser;',
  'the annotations come back here as a message once the review is submitted.',
  '',
  'usage:',
  '  /plannotator <file|folder|url>   review that target',
  "  /plannotator                     review this session's workspace folder",
  '  /plannotator help                this text',
].join('\n');

/**
 * Parse the slash-command input into an invocation plan.
 *
 * The whole input is one target, so a path containing spaces needs no escaping
 * (surrounding quotes are tolerated for habit's sake). There are no flags left to
 * parse, which is why this is a fraction of what it used to be.
 *
 * @param {string} rawInput Everything after the command name.
 * @param {string} cwd The workspace directory a relative target resolves against.
 * @returns {{kind:'help'}|{kind:'error', text:string}|{kind:'review', target:string}}
 */
export function parseInput(rawInput, cwd) {
  const trimmed = stripQuotes(String(rawInput ?? '').replace(/[\r\n\t]+/g, ' ').trim());
  if (trimmed === 'help' || trimmed === '--help' || trimmed === '-h') return { kind: 'help' };
  if (trimmed === '' || trimmed === '.') return { kind: 'review', target: cwd };
  if (trimmed.startsWith('-')) return { kind: 'error', text: `unknown option ${trimmed}\n\n${HELP_TEXT}` };
  return { kind: 'review', target: trimmed };
}

/** Strip one pair of matching outer quotes, so a quoted path with spaces works. */
function stripQuotes(value) {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value[value.length - 1] === first) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Turn the parsed invocation into concrete Plannotator arguments.
 *
 * @returns {{kind:'error', text:string}|{kind:'ok', argv:string[], cwd:string, label:string, gate:boolean, open:boolean, port:number|null, timeoutMs:number}}
 */
export function buildReviewCommand(invocation, runtime, workspaceDir) {
  const { config } = runtime;
  const cwd = workspaceDir ?? process.cwd();
  const outcome = {
    kind: 'ok',
    argv: [],
    cwd,
    label: '',
    gate: config.gate,
    open: config.openBrowser,
    port: config.port,
    timeoutMs: config.timeoutMs,
  };

  const expanded = expandHome(String(invocation.target ?? cwd));
  if (/^https?:\/\//i.test(expanded)) {
    outcome.label = expanded;
    outcome.argv = ['annotate', expanded, '--json'];
    return outcome;
  }

  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  if (!pathExists(resolved)) {
    return { kind: 'error', text: `nothing to annotate at ${resolved}` };
  }
  outcome.label = resolved;
  outcome.argv = ['annotate', resolved, '--json'];
  return outcome;
}
