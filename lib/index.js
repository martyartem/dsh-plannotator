/**
 * plannotator-dsh — Plannotator inside DeepSeek Harness.
 *
 * One host row (see cordis.patch.yml) that gives the harness:
 *   • `/plannotator` (alias `/plannotate`) — review a file, a folder or a web page
 *     in the Plannotator browser UI; there is no other command and no flags;
 *   • detached review sessions, so the turn keeps going and the returned
 *     annotations arrive as an agent message instead of a blocked tool call;
 *   • binary discovery that does not depend on the session's minimal PATH, a
 *     workspace resolver that ignores the host process cwd, and
 *     `PLANNOTATOR_ORIGIN=dsh` so archived reviews are attributed correctly.
 *
 * The plugin talks to the Plannotator CLI only through its documented stdout
 * contract (`--json`) and readiness file; it never scrapes the browser UI.
 *
 * @module plannotator-dsh
 */

import { NAME, VERSION, createRuntime } from './config.js';
import { resolveBinary, missingBinaryMessage, WELL_KNOWN_BINARIES } from './binary.js';
import { HELP_TEXT, parseInput, buildReviewCommand } from './command.js';
import { startReview } from './review.js';
import { resolveWorkspace } from './workspace.js';

export const name = NAME;
export const inject = ['commands'];

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config);
  const binary = resolveBinary(runtime.config.binary, process.env, undefined, runtime.config.binaryFallbacks ?? WELL_KNOWN_BINARIES);

  if (binary === null) {
    ctx.logger?.warn?.(`[${NAME}] ${missingBinaryMessage()}`);
    runtime.log('loaded without a plannotator binary');
  } else {
    runtime.log(`loaded ${VERSION}; binary=${binary}; hostCwd=${process.cwd()}`);
  }

  const definition = {
    definitionId: 'plannotator-dsh:review',
    name: 'plannotator',
    description: 'Review documentation, files, folders, URLs or diffs in the Plannotator browser UI',
    input: { hint: '<file|folder|url>' },
    handler: (invocation) => handle(invocation),
  };

  // The UI half calls this route instead of pulling a host service into the browser.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer ?? scoped.get?.('webServer') ?? null;
    if (!webServer || typeof webServer.register !== 'function') {
      runtime.log('no webServer service: the UI button route is unavailable');
      return;
    }
    scoped.effect(
      () =>
        webServer.register({
          path: '/plannotator/review',
          kind: 'exact',
          handler: (request, response) => handleReviewRoute(request, response),
        }),
      `${NAME}: /plannotator/review route`,
    );
    scoped.effect(
      () =>
        webServer.register({
          path: '/plannotator/log',
          kind: 'exact',
          handler: (request, response) => handleLogRoute(request, response),
        }),
      `${NAME}: /plannotator/log route`,
    );
    runtime.log('registered /plannotator/review and /plannotator/log');
  });

  ctx.effect(() => ctx.commands.register(definition), `${NAME}: /plannotator`);
  ctx.effect(() => ctx.commands.register({ ...definition, definitionId: 'plannotator-dsh:review-alias', name: 'plannotate' }), `${NAME}: /plannotate alias`);

  async function handle(invocation) {
    const rawInput = invocation.rawInput ?? '';
    const workspace = resolveWorkspace({ agent: invocation.agent, ctx });
    runtime.log(`command: ${JSON.stringify(rawInput.trim())} workspace=${workspace.dir} (${workspace.source})`);

    if (binary === null) return { kind: 'error', text: missingBinaryMessage() };

    const parsed = parseInput(rawInput, workspace.dir);
    if (parsed.kind === 'help') return settle({ kind: 'success', text: HELP_TEXT });
    if (parsed.kind === 'error') return settle({ kind: 'error', text: parsed.text });

    const command = buildReviewCommand(parsed, runtime, workspace.dir);
    if (command.kind === 'error') return { kind: 'error', text: command.text };

    let started;
    try {
      started = await startReview({ binary, invocation: command, runtime });
    } catch (error) {
      return { kind: 'error', text: `could not start Plannotator: ${String(error?.message ?? error)}` };
    }
    if (!started.ok) return { kind: 'error', text: `Plannotator did not start: ${started.error}` };

    const session = started.session;
    session.once('settled', () => {
      try {
        session.settle(invocation.agent ?? null);
      } finally {
        session.dispose();
      }
    });

    return settle({ kind: 'success', text: session.startText() });
  }

  /**
   * `POST /plannotator/log` — the browser half's console, forwarded to the
   * plugin log so a client-side registration problem is visible host-side.
   */
  function handleLogRoute(request, response) {
    const json = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' });
      response.end();
      return;
    }
    if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_384) request.destroy();
    });
    request.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { message: body.slice(0, 500) };
      }
      const level = typeof parsed?.level === 'string' ? parsed.level : 'info';
      const message = String(parsed?.message ?? '').replace(/\s+/g, ' ').slice(0, 800);
      runtime.log(`client[${level}]: ${message}`);
      json(200, { ok: true });
    });
  }

  /**
   * The live agent a UI-launched review should report back to.
   *
   * The browser half stamps the session it was rendered in onto the route, so an
   * explicit id wins outright: it is the session the human is looking at, and a
   * review started there must come back there even when another session happens
   * to be the one running work. Without an id — an older client half, or a seat
   * that carries no session — fall back to the previous heuristic: prefer an
   * agent that is actually executing work, else the newest live one.
   *
   * @param context - host context providing the `agents` registry.
   * @param requestedId - session id claimed by the client, when it sent one.
   */
  function liveAgent(context, requestedId = null) {
    const registry = context?.get?.('agents') ?? null;
    if (registry === null || typeof registry.list !== 'function') return null;
    try {
      if (typeof requestedId === 'string' && requestedId !== '') {
        const named = typeof registry.get === 'function' ? registry.get(requestedId) : null;
        if (named && typeof named.steer === 'function') return named;
        // A live agent for that id is the only agent the feedback may reach:
        // guessing another session would deliver the review to the wrong chat.
        const known = registry.list().some((candidate) => candidate?.id === requestedId);
        runtime.log(
          known
            ? `agents lookup: session ${requestedId} carries no steerable agent; the decision stays in the log`
            : `agents lookup: session ${requestedId} is not live; the decision stays in the log`,
        );
        return null;
      }
      const listed = registry.list();
      const candidates = (Array.isArray(listed) ? listed : []).filter((candidate) => candidate && typeof candidate.steer === 'function');
      if (candidates.length === 0) return null;
      // Prefer the agent that is actually executing work: a review started from the
      // UI belongs to whatever session is running, and steering a quiet session
      // would either wake it wrongly or be rejected as no-turn.
      const running = candidates.filter((candidate) => isRunning(candidate));
      const pool = running.length > 0 ? running : candidates;
      return pool[pool.length - 1];
    } catch (error) {
      runtime.log(`agents lookup failed: ${String(error?.message ?? error)}`);
    }
    return null;
  }

  /**
   * Whether an agent currently has work in flight.
   *
   * The host types this as `AgentStatus = 'idle' | 'running'`. `status` is reached
   * through a getter on a live handle, so the read stays guarded.
   */
  function isRunning(agent) {
    try {
      return agent?.status === 'running';
    } catch {
      return false;
    }
  }

  /**
   * `GET /plannotator/review?target=<path|url>&gate=1&session=<id>`
   *
   * The sidebar button path: start a detached session and answer with its URL
   * so the browser can show it, without waiting for the reviewer. `session` is
   * the session the browser rendered the button in, so the returned annotations
   * go back to that chat instead of to whichever session happens to be running.
   */
  async function handleReviewRoute(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const target = url.searchParams.get('target') ?? '';
    const json = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };

    if (binary === null) return json(503, { ok: false, error: missingBinaryMessage() });
    if (target === '') return json(400, { ok: false, error: 'target is required' });

    const resolved = resolveWorkspace({ env: process.env });
    const parsed = parseInput(target, resolved.dir);
    if (parsed.kind !== 'review') return json(400, { ok: false, error: 'not a review target' });

    const command = buildReviewCommand(parsed, runtime, resolved.dir);
    if (command.kind === 'error') return json(400, { ok: false, error: command.text });

    runtime.log(`ui route: target=${JSON.stringify(target)} workspace=${resolved.dir} (${resolved.source})`);
    let started;
    try {
      // The UI route and the command share one session entry point: the built
      // command already carries argv, cwd, label, gate, open, port and timeout.
      started = await startReview({ binary, invocation: command, runtime });
    } catch (error) {
      return json(500, { ok: false, error: String(error?.message ?? error) });
    }
    if (!started.ok) return json(502, { ok: false, error: started.error });

    const session = started.session;
    // The client stamps the session it rendered in. Without one, assume the
    // session that owns this plugin process: guessing from the live registry is
    // what delivered earlier reviews to a chat the human was not looking at.
    const requestedSession = url.searchParams.get('session') ?? process.env.DSH_SESSION_ID ?? null;
    session.agent = liveAgent(ctx, requestedSession);
    if (session.agent === null) {
      runtime.log(`ui session ${session.id}: no agent for session ${requestedSession ?? '(unknown)'}, annotations stay in the log`);
    } else {
      runtime.log(`ui session ${session.id}: annotations will return to session ${session.agent.id}`);
    }
    session.once('settled', () => {
      try {
        session.settle(session.agent);
      } finally {
        session.dispose();
      }
    });
    runtime.log(`ui route: session ${session.id} ready at ${session.url}`);
    return json(200, { ok: true, url: session.url, label: command.label, gate: command.gate });
  }

  /** Record every result the host is about to render, then hand it back unchanged. */
  function settle(result) {
    const text = result.kind === 'success' ? result.text ?? '' : result.text;
    const firstLine = String(text).split('\n')[0];
    runtime.log(`result: kind=${result.kind} chars=${String(text).length} first=${JSON.stringify(firstLine)}`);
    return result;
  }
}
