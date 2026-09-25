import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isExecutableFile } from './config.js';

/** Install locations to try after PATH, with `~` replaced by the caller's home. */
export const WELL_KNOWN_BINARIES = [
  '~/.local/bin/plannotator',
  '/usr/local/bin/plannotator',
  '/opt/homebrew/bin/plannotator',
  '~/.bun/bin/plannotator',
  '~/.cargo/bin/plannotator',
];

/**
 * Resolve the Plannotator binary.
 *
 * A DSH session runs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the
 * common `~/.local/bin/plannotator` install is invisible to a bare `plannotator`
 * call. Resolution order: explicit config, environment, PATH, well-known dirs,
 * and finally a macOS bundle copy.
 */
export function candidateBinaries(configured, env = process.env, home = os.homedir(), wellKnown = [...WELL_KNOWN_BINARIES]) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (env.PLANNOTATOR_BIN) candidates.push(env.PLANNOTATOR_BIN);

  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') candidates.push(path.join(dir, 'plannotator'));
  }

  for (const candidate of wellKnown) {
    candidates.push(candidate.replace('~', home));
  }
  return candidates;
}

export function resolveBinary(configured, env = process.env, home = os.homedir(), wellKnown) {
  for (const candidate of candidateBinaries(configured, env, home, wellKnown)) {
    if (isExecutableFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

export function missingBinaryMessage() {
  return [
    'Plannotator CLI was not found.',
    'Install it, or point this plugin at it:',
    '  • set PLANNOTATOR_BIN=/absolute/path/to/plannotator in the DSH environment, or',
    '  • add `binary: /absolute/path/to/plannotator` to the plugin config, or',
    '  • symlink it into a directory that is already on PATH:',
    '      ln -s ~/.local/bin/plannotator /usr/local/bin/plannotator',
  ].join('\n');
}

export function expandHome(target, home = os.homedir()) {
  if (target === '~') return home;
  return target.startsWith('~/') ? path.join(home, target.slice(2)) : target;
}

export function pathExists(target) {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}
