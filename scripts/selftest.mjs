/**
 * Offline self-test for plannotator-dsh.
 *
 * The DSH loader is not available outside a booted profile, so this harness
 * fakes the two seams the plugin uses — `ctx.commands.register()` and a
 * command invocation — and exercises parsing, binary resolution, session
 * startup, the detached decision record and agent steering.
 *
 *   node scripts/selftest.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';
import { parseInput, buildReviewCommand, HELP_TEXT } from '../lib/command.js';
import { createRuntime } from '../lib/config.js';
import { resolveBinary, candidateBinaries } from '../lib/binary.js';
import { resolveWorkspace, workspaceFromSessionLog, readHeaderCwd, newestSessionWorkspace } from '../lib/workspace.js';

const CWD = process.cwd();
const results = [];
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

function fakeCtx({ webServer = null, agents = null } = {}) {
  const registry = new Map();
  const routes = new Map();
  const services = new Map();
  if (webServer !== null) services.set('webServer', webServer);
  if (agents !== null) services.set('agents', agents);
  const ctx = {
    registry,
    routes,
    logger: { warn: () => {}, info: () => {} },
    commands: {
      register(definition) {
        registry.set(definition.name, definition);
        return () => registry.delete(definition.name);
      },
    },
    effect(callback) {
      callback();
    },
    get(key) {
      return services.get(key);
    },
    inject(keys, callback) {
      const available = keys.every((key) => services.has(key));
      if (!available) return;
      const scoped = {
        ...ctx,
        get: ctx.get,
        webServer: services.get('webServer'),
        effect: ctx.effect,
      };
      callback(scoped);
    },
  };
  return ctx;
}

/** A minimal fake of the host webserver: records routes and lets a test call one. */
function fakeWebServer(routes) {
  return {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
}

/** Call a registered route with a fake request/response pair. */
async function callRoute(route, url) {
  let status = null;
  let body = '';
  const response = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      body += chunk ?? '';
    },
  };
  await route.handler({ url, method: 'GET' }, response);
  return { status, body: body === '' ? null : JSON.parse(body) };
}

function fakeInvocation(rawInput, agent = null) {
  return { commandId: 'cmd-test', agent, rawInput, attachments: [], signal: undefined };
}

/** A stand-in for the plannotator binary: writes a readiness file, then a decision. */
function makeFakeBinary(dir, { decision = 'annotated', feedback = 'Please shorten section 2.', exitCode = 0, delayMs = 400 } = {}) {
  const binary = path.join(dir, 'fake-plannotator');
  const code = [
    'const fs = require("node:fs");',
    'const ready = process.env.PLANNOTATOR_READY_FILE;',
    'if (ready) fs.writeFileSync(ready, JSON.stringify({ url: "http://localhost:12345", isRemote: false, port: 12345 }));',
    `setTimeout(() => { process.stdout.write(JSON.stringify({ decision: ${JSON.stringify(decision)}, feedback: ${JSON.stringify(feedback)} }) + "\\n"); process.exit(${exitCode}); }, ${delayMs});`,
  ].join('\n');
  const script = `#!/bin/sh\nexec "${process.execPath}" -e '${code.replace(/'/g, `'\\''`)}'\n`;
  fs.writeFileSync(binary, script, { mode: 0o755 });
  return binary;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plannotator-dsh-selftest-'));
const headerLine = `${JSON.stringify({ type: 'session', version: 4, id: 'sess-1', cwd: tmp })}\n`;
fs.mkdirSync(path.join(tmp, 'sessions', '--proj--', 'sess-1'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'sessions', '--proj--', 'sess-1', 'session.v4.jsonl.zstd'), headerLine);
const runtime = createRuntime({ dataDir: path.join(tmp, 'data'), debug: false });

// --- parsing -----------------------------------------------------------------
check('a bare invocation reviews the workspace folder', () => {
  const built = buildReviewCommand(parseInput('', tmp), runtime, tmp);
  assert.equal(built.kind, 'ok');
  assert.deepEqual(built.argv, ['annotate', tmp, '--json']);
  return built.argv.join(' ');
});

check('a file target becomes an absolute annotate call', () => {
  const file = path.join(tmp, 'note.md');
  fs.writeFileSync(file, '# Note\n');
  const built = buildReviewCommand(parseInput('note.md', tmp), runtime, tmp);
  assert.equal(built.kind, 'ok');
  assert.deepEqual(built.argv, ['annotate', file, '--json']);
  return built.argv.join(' ');
});

check('a target with spaces needs no escaping, quoted or bare', () => {
  const spaced = path.join(tmp, 'my notes.md');
  fs.writeFileSync(spaced, '# Notes\n');
  assert.deepEqual(buildReviewCommand(parseInput('my notes.md', tmp), runtime, tmp).argv, ['annotate', spaced, '--json']);
  assert.deepEqual(buildReviewCommand(parseInput(`"${spaced}"`, tmp), runtime, tmp).argv, ['annotate', spaced, '--json']);
});

check('a target that does not exist is an error', () => {
  const built = buildReviewCommand(parseInput('gone.md', tmp), runtime, tmp);
  assert.equal(built.kind, 'error');
  assert.match(built.text, /nothing to annotate/);
});

check('urls pass through untouched', () => {
  const built = buildReviewCommand(parseInput('https://example.com/spec', tmp), runtime, tmp);
  assert.deepEqual(built.argv, ['annotate', 'https://example.com/spec', '--json']);
});

check('config drives gate, port and timeout — there are no flags left', () => {
  const configured = createRuntime({ gate: true, port: 19999, timeoutMs: 60_000 });
  const built = buildReviewCommand(parseInput('note.md', tmp), configured, tmp);
  assert.equal(built.gate, true);
  assert.equal(built.port, 19999);
  assert.equal(built.timeoutMs, 60_000);
});

check('the removed subcommands parse as ordinary targets, not modes', () => {
  for (const gone of ['docs', 'last', 'archive', 'review']) {
    assert.deepEqual(parseInput(gone, tmp), { kind: 'review', target: gone }, `${gone} must not be a mode any more`);
  }
});

check('an unknown option fails loudly', () => {
  const parsed = parseInput('--gate note.md', tmp);
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.text, /unknown option/);
});

check('help text is returned for help', () => {
  assert.equal(parseInput('help', tmp).kind, 'help');
  assert.match(HELP_TEXT, /\/plannotator <file\|folder\|url>/);
});

// --- binary resolution -------------------------------------------------------
check('binary resolution ignores a missing configured path and finds an executable', () => {
  const binary = makeFakeBinary(tmp);
  const resolved = resolveBinary(binary);
  assert.equal(resolved, path.resolve(binary));
  return resolved;
});

check('binary resolution reports null when nothing is executable', () => {
  assert.equal(resolveBinary(path.join(tmp, 'definitely-not-here'), { PATH: '' }, tmp, []), null);
});

check('candidate order is config, env, PATH, then well-known dirs', () => {
  const list = candidateBinaries('/cfg/pn', { PATH: '/a:/b', PLANNOTATOR_BIN: '/env/pn' }, '/home/u', ['~/.local/bin/plannotator']);
  assert.deepEqual(list, ['/cfg/pn', '/env/pn', '/a/plannotator', '/b/plannotator', '/home/u/.local/bin/plannotator']);
});

// --- workspace resolution ----------------------------------------------------
check('the live agent session directory wins', () => {
  const resolved = resolveWorkspace({ agent: { session: { directory: '/w/agent' } }, env: {} });
  assert.deepEqual(resolved, { dir: '/w/agent', source: 'agent session' });
});

check('the workspace registry answers when the session carries no directory', () => {
  const ctx = { get: (key) => (key === 'workspaceRegistry' ? { list: () => [{ directory: '/w/registry' }] } : undefined) };
  assert.deepEqual(resolveWorkspace({ agent: { session: {} }, ctx, env: {} }), { dir: '/w/registry', source: 'workspace registry' });
});

check('the session-log header answers last', () => {
  const found = workspaceFromSessionLog({ env: { DSH_SESSION_ID: 'sess-1', DSH_HOME: tmp }, home: tmp });
  assert.equal(found, tmp);
  return found;
});

check('a hostile agent.session getter falls back instead of crashing', () => {
  const hostile = { get session() { throw new Error('hostile getter'); } };
  const resolved = resolveWorkspace({ agent: hostile, env: { DSH_HOME: tmp, DSH_SESSION_ID: 'sess-1' } });
  assert.equal(resolved.dir, tmp);
  assert.notEqual(resolved.source, 'agent session');
  return resolved.source;
});

check('without a session id the newest session workspace is used', () => {
  const found = newestSessionWorkspace({ env: { DSH_HOME: tmp }, home: tmp });
  assert.equal(found, tmp);
  return found;
});

check('the host process cwd is only a last resort', () => {
  const resolved = resolveWorkspace({ env: { DSH_HOME: path.join(tmp, 'empty'), DSH_SESSION_ID: 'missing' } });
  assert.equal(resolved.source, 'host cwd');
});

// --- plugin wiring -----------------------------------------------------------
const uiRoutes = new Map();
const ctx = fakeCtx({ webServer: fakeWebServer(uiRoutes) });
const binary = makeFakeBinary(tmp);
const savedSessionId = process.env.DSH_SESSION_ID;
delete process.env.DSH_SESSION_ID;
apply(ctx, { binary, dataDir: path.join(tmp, 'data'), readyTimeoutMs: 5_000, autoFollowup: true });

check('the plugin registers /plannotator and its alias', () => {
  assert.deepEqual([...ctx.registry.keys()].sort(), ['plannotate', 'plannotator']);
});

await (async () => {
  const route = uiRoutes.get('/plannotator/review');
  check('the UI route is registered', () => {
    assert.ok(route, 'no /plannotator/review route');
    assert.equal(route.kind, 'exact');
  });

  const file = path.join(tmp, 'note.md');
  const ok = await callRoute(route, `/plannotator/review?target=${encodeURIComponent(file)}`);
  check('the UI route starts a review and answers with its URL', () => {
    assert.equal(ok.status, 200);
    assert.match(ok.body.url, /^http:\/\/localhost:/);
    assert.equal(ok.body.ok, true);
    return ok.body.url;
  });

  const missing = await callRoute(route, '/plannotator/review?target=');
  check('the UI route rejects a missing target', () => {
    assert.equal(missing.status, 400);
    assert.equal(missing.body.ok, false);
  });

  const nowhere = await callRoute(route, '/plannotator/review?target=nope/missing.md');
  check('the UI route rejects a target that does not exist', () => {
    assert.equal(nowhere.status, 400);
    assert.match(nowhere.body.error, /nothing to annotate/);
  });
})();

await (async () => {
  // Routing regression: a UI review must report to the session the button was
  // rendered in, never to whichever session happens to be running work.
  const steered = { mine: [], other: [] };
  const agents = new Map([
    ['mine', { id: 'mine', status: 'idle', steer: (message) => steered.mine.push(message) }],
    ['other', { id: 'other', status: 'working', steer: (message) => steered.other.push(message) }],
  ]);
  const registry = {
    list: () => [...agents.values()],
    roots: () => [...agents.values()],
    get: (id) => agents.get(id),
  };
  const routes = new Map();
  const routeCtx = fakeCtx({ webServer: fakeWebServer(routes), agents: registry });
  const savedId = process.env.DSH_SESSION_ID;
  delete process.env.DSH_SESSION_ID;
  apply(routeCtx, { binary: makeFakeBinary(tmp), dataDir: path.join(tmp, 'routing-data'), readyTimeoutMs: 5_000, autoFollowup: true });
  const route = routes.get('/plannotator/review');
  const file = path.join(tmp, 'note.md');

  const named = await callRoute(route, `/plannotator/review?target=${encodeURIComponent(file)}&session=mine`);
  check('the UI route accepts a session claim', () => {
    assert.equal(named.status, 200);
    assert.equal(named.body.ok, true);
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 1_200);
  });

  check('a claimed session receives the annotations even while another session runs', () => {
    assert.equal(steered.mine.length, 1, `expected the claimed session to be steered, got ${steered.mine.length}`);
    assert.equal(steered.other.length, 0, 'the running session must not receive a review claimed elsewhere');
    assert.equal(steered.mine[0].role, 'user');
    return steered.mine[0].content[0].text.split('\n')[0];
  });

  // A claim for a session with no live agent must not fall back to a guess.
  const unknown = await callRoute(route, `/plannotator/review?target=${encodeURIComponent(file)}&session=ghost`);
  check('the UI route accepts a claim for an unknown session without error', () => {
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.ok, true);
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 1_200);
  });

  check('an unknown session claim never delivers to another session', () => {
    assert.equal(steered.mine.length, 1, 'the named session received an extra message');
    assert.equal(steered.other.length, 0, 'feedback fell back to a guessed session');
  });

  if (savedId === undefined) delete process.env.DSH_SESSION_ID;
  else process.env.DSH_SESSION_ID = savedId;
})();

await (async () => {
  const result = await ctx.registry.get('plannotator').handler(fakeInvocation('help'));
  check('help runs through the registered command', () => {
    assert.equal(result.kind, 'success');
    assert.match(result.text, /\/plannotator <file\|folder\|url>/);
  });
})();

await (async () => {
  // A multi-word input is one path, not a broken subcommand: there are no
  // subcommands left to misread it as.
  const phraseCtx = fakeCtx();
  apply(phraseCtx, {
    binary: makeFakeBinary(tmp),
    dataDir: path.join(tmp, 'data'),
    binaryFallbacks: [],
  });
  const invoke = (raw) => phraseCtx.registry.get('plannotator').handler(fakeInvocation(raw, { session: { directory: tmp }, steer: () => {} }));

  const strayWords = await invoke('diag отдает ошибку');
  check('a multi-word phrase is treated as a path, not a broken subcommand', () => {
    assert.equal(strayWords.kind, 'error');
    assert.match(strayWords.text, /nothing to annotate/);
  });
})();

await (async () => {
  const steered = [];
  const agent = {
    session: { directory: tmp },
    steer: (message) => steered.push(message),
  };
  const file = path.join(tmp, 'note.md');
  const result = await ctx.registry.get('plannotator').handler(fakeInvocation('note.md', agent));
  check('a review answers with the URL instead of blocking', () => {
    assert.equal(result.kind, 'success');
    assert.match(result.text, /http:\/\/localhost:12345/);
    assert.match(result.text, /note\.md/);
    return result.text.split('\n')[0];
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 1_200);
  });

  check('the decision comes back as a steered agent message', () => {
    assert.equal(steered.length, 1, `expected one steered message, got ${steered.length}`);
    const text = steered[0].content[0].text;
    assert.match(text, /Please shorten section 2\./);
    // Session format v4: a plugin stamps `plugin:<name>`, not a bare kind + name.
    assert.equal(steered[0].source.kind, 'plugin:plannotator-dsh');
    // The log stores the message verbatim and the provider request is built from
    // it: a steered UserMessage without `role` is admitted to the log but breaks
    // every later request with `messages[N]: missing field \`role\`` (HTTP 422).
    assert.equal(steered[0].role, 'user', 'a steered UserMessage must carry role: user');
    // A steered UserMessage needs an `id`. The append path admits an unidentified
    // message, but the restore path then rejects the whole session on the next load
    // with "session event at seq N lacks an identified message" — the history
    // vanishes after a restart.
    assert.equal(typeof steered[0].id, 'string', 'a steered UserMessage must carry an id');
    assert.notEqual(steered[0].id, '', 'the steered message id must not be empty');
    return text.split('\n')[0];
  });

  check('the target file was left alone', () => {
    assert.equal(fs.readFileSync(file, 'utf8'), '# Note\n');
  });
})();

// --- an abandoned review must not sit there forever ---------------------------
// `--timeout` (and the matching config key) is a wall-clock budget for the human:
// the barrier is a detached process, so without a deadline an abandoned review
// would never settle and the flag would silently do nothing.
await (async () => {
  const steered = [];
  const timeoutAgent = { session: { directory: tmp }, steer: (message) => steered.push(message) };
  const abandoned = path.join(tmp, 'abandoned.md');
  fs.writeFileSync(abandoned, '# Abandoned\n');
  const timeoutCtx = fakeCtx();
  apply(timeoutCtx, {
    binary: makeFakeBinary(tmp, { delayMs: 30_000 }),
    dataDir: path.join(tmp, 'data-timeout'),
    binaryFallbacks: [],
    timeoutMs: 120,
  });

  const result = await timeoutCtx.registry.get('plannotator').handler(fakeInvocation('abandoned.md', timeoutAgent));
  assert.equal(result.kind, 'success', `unexpected result: ${JSON.stringify(result)}`);
  await new Promise((resolve) => {
    setTimeout(resolve, 1_200);
  });

  check('a review that outlives its timeout is stopped and reported', () => {
    assert.equal(steered.length, 1, `expected one steered message, got ${steered.length}`);
    const text = steered[0].content[0].text;
    assert.match(text, /still open after/, `unexpected text: ${text.slice(0, 200)}`);
    assert.match(text, /seconds/, 'a sub-minute budget must read as seconds');
    return text.split('\n')[0];
  });
})();

await (async () => {
  const slow = fakeCtx();
  const missing = makeFakeBinary(tmp, { exitCode: 3, delayMs: 50 });
  apply(slow, { binary: missing, dataDir: path.join(tmp, 'data'), readyTimeoutMs: 250, autoFollowup: false });
  // An absolute target, so the command reaches the session instead of failing on
  // target resolution first: the workspace here has no live agent to resolve from.
  const result = await slow.registry.get('plannotator').handler(fakeInvocation(path.join(tmp, 'note.md')));
  check('a failing binary surfaces as a command error with process output', () => {
    assert.equal(result.kind, 'error');
    assert.match(result.text, /did not start|exited/);
    return result.text.split('\n')[0];
  });
})();

if (savedSessionId !== undefined) process.env.DSH_SESSION_ID = savedSessionId;

await (async () => {
  const noBinary = fakeCtx();
  const realEnv = process.env;
  try {
    process.env = { ...realEnv, PATH: '', PLANNOTATOR_BIN: '' };
    apply(noBinary, { binary: path.join(tmp, 'nope'), dataDir: path.join(tmp, 'data'), binaryFallbacks: [] });
    process.env = realEnv;
    const result = await noBinary.registry.get('plannotator').handler(fakeInvocation('last'));
    check('a missing binary produces install guidance, not a crash', () => {
      assert.equal(result.kind, 'error');
      assert.match(result.text, /PLANNOTATOR_BIN/);
    });
  } finally {
    process.env = realEnv;
  }

})();

process.stdout.write(`${results.join('\n')}\n\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — ${results.length} checks\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
