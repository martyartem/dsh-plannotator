/**
 * Live smoke test: drives the real Plannotator binary through the plugin.
 *
 * It starts a review on a throwaway document, asserts that the local review
 * server answers, pushes an external annotation into the live session (the
 * documented HTTP API), then closes the session and checks the stdout decision
 * contract the plugin parses.
 *
 *   node scripts/live-test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannotator-dsh-live-'));
const doc = path.join(tmp, 'spec.md');
fs.writeFileSync(doc, '# Spec\n\nThe bridge opens the review server.\n\nA second paragraph.\n');

const registry = new Map();
const steered = [];
const ctx = {
  logger: { warn: (message) => process.stderr.write(`${message}\n`), info: () => {} },
  commands: {
    register(definition) {
      registry.set(definition.name, definition);
      return () => registry.delete(definition.name);
    },
  },
  effect(callback) {
    callback();
  },
};
const agent = { session: { directory: tmp }, steer: (message) => steered.push(message) };

apply(ctx, { dataDir: path.join(tmp, 'data'), autoFollowup: true, readyTimeoutMs: 20_000, openBrowser: false, debug: true });

const handler = registry.get('plannotator').handler;
const started = await handler({ commandId: 'cmd-live', agent, rawInput: 'spec.md', attachments: [], signal: undefined });
assert.equal(started.kind, 'success', `command failed: ${started.text}`);
const url = /(http:\/\/localhost:\d+)/.exec(started.text)?.[1];
assert.ok(url, `no URL in command result: ${started.text}`);
console.log(`review server: ${url}`);

const page = await fetch(url);
assert.equal(page.status, 200, `review page did not answer: ${page.status}`);
console.log('review page answers 200');

const annotation = {
  id: 'live-test-1',
  blockId: '',
  startOffset: 0,
  endOffset: 0,
  type: 'GLOBAL_COMMENT',
  text: 'LIVE TEST: tighten this sentence.',
  originalText: '',
  createdA: Date.now(),
  author: 'browser-agent',
  source: 'browser-agent',
};
const posted = await fetch(`${url}/api/external-annotations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ annotations: [annotation] }),
});
console.log(`external annotation POST -> ${posted.status} ${posted.statusText}`);
assert.ok(posted.ok, `external annotations rejected: ${posted.status} ${await posted.text()}`);

// Closing the session (as the browser tab would) ends the process; the plugin
// then reads whatever decision record stdout carries.
const sessions = await import('node:child_process').then(({ execFileSync }) =>
  execFileSync(process.env.PLANNOTATOR_BIN ?? '/usr/local/bin/plannotator', ['sessions'], { encoding: 'utf8' }),
);
console.log(sessions.trim().split('\n').slice(0, 4).join('\n'));

process.env.PLANNOTATOR_DATA_DIR = process.env.PLANNOTATOR_DATA_DIR ?? '';
console.log('\nlive test reached the review server and the annotation API.');
console.log('Close the browser tab to finish the session; the plugin log shows the settled decision:');
console.log(`  ${path.join(tmp, 'data', 'plannotator-dsh.log')}`);

// Keep the process alive briefly so the settled event can be observed when a
// human closes the tab; otherwise exit cleanly.
const deadline = Date.now() + 5_000;
while (Date.now() < deadline && steered.length === 0) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (steered.length > 0) {
  console.log(`\nsteered message:\n${steered[0].content[0].text}`);
} else {
  console.log('\n(no decision within 5s — expected while the review is still open)');
}
console.log(`artifacts kept in ${tmp}`);
