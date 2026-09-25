import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { NAME, truncate } from './config.js';

const FEEDBACK_LIMIT = 12_000;

/**
 * Start one detached Plannotator session.
 *
 * The review blocks by design, so the child is detached from this turn: the
 * command answers as soon as the local server is up, and the decision is
 * delivered later through the returned emitter's `settled` event.
 *
 * @returns {Promise<{ok: true, session: ReviewSession} | {ok: false, error: string}>}
 */
export async function startReview({ binary, invocation, runtime }) {
  const { config, log } = runtime;
  const id = `pn-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const scratch = path.join(os.tmpdir(), 'plannotator-dsh', id);
  const readyFile = path.join(scratch, 'ready.json');

  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch (error) {
    return { ok: false, error: `could not create ${scratch}: ${String(error?.message ?? error)}` };
  }

  const env = {
    ...process.env,
    PLANNOTATOR_ORIGIN: config.origin,
    PLANNOTATOR_READY_FILE: readyFile,
  };
  if (invocation.port !== null) env.PLANNOTATOR_PORT = String(invocation.port);

  const child = spawn(binary, invocation.argv, {
    cwd: invocation.cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = new ReviewSession({ id, child, invocation, readyFile, scratch, runtime });
  session.capture();
  child.unref();

  const ready = await session.waitForReady();
  if (!ready.ok) {
    session.dispose();
    return { ok: false, error: ready.error };
  }
  session.armTimeout();

  log(`session ${id} ready: ${session.url} (${invocation.argv.join(' ')})`);
  return { ok: true, session };
}

export class ReviewSession extends EventEmitter {
  constructor({ id, child, invocation, readyFile, scratch, runtime }) {
    super();
    this.id = id;
    this.child = child;
    this.invocation = invocation;
    this.readyFile = readyFile;
    this.scratch = scratch;
    this.runtime = runtime;
    this.stdout = '';
    this.stderr = '';
    this.url = null;
    this.exitCode = null;
    this.signal = null;
    /**
     * Wall-clock budget for the human's review, in ms. A detached session has no
     * other deadline: the CLI blocks until the reviewer submits.
     */
    this.timeoutMs = Number.isSafeInteger(invocation.timeoutMs) && invocation.timeoutMs > 0
      ? invocation.timeoutMs
      : runtime.config.timeoutMs;
    this.timer = null;
    /** Whether {@link armTimeout} stopped the session rather than the reviewer. */
    this.timedOut = false;
    /** The agent a UI-launched review reports back to, when one is live. */
    this.agent = null;
  }

  capture() {
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk) => {
      this.stdout += chunk;
    });
    this.child.stderr?.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.on('error', (error) => {
      this.runtime.log(`session ${this.id} failed to spawn: ${String(error?.message ?? error)}`);
      this.exitCode = -1;
      this.emit('settled', { error: String(error?.message ?? error) });
    });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
      this.runtime.log(`session ${this.id} exited code=${code} signal=${signal}`);
      this.emit('settled', {});
    });
  }

  async waitForReady() {
    const deadline = Date.now() + this.runtime.config.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        return { ok: false, error: this.failureMessage() };
      }
      const parsed = this.readReadyFile();
      if (parsed) {
        this.url = parsed.url;
        return { ok: true };
      }
      await delay(150);
    }
    return { ok: false, error: this.failureMessage('the review server did not report readiness in time') };
  }

  /**
   * Stop waiting for the human once the configured budget runs out.
   *
   * Without this the detached process would sit on an abandoned review forever and
   * the decision would never settle, so `config.timeoutMs` would be a setting that
   * does nothing. The timer is unref'd, so a pending review never keeps the host
   * process alive.
   */
  armTimeout() {
    if (this.timer !== null || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.runtime.log(`session ${this.id} timed out after ${Math.round(this.timeoutMs / 60_000)} min; stopping it`);
      try {
        this.child.kill('SIGTERM');
      } catch {
        // A child that already exited needs no signal.
      }
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  readReadyFile() {
    try {
      const raw = fs.readFileSync(this.readyFile, 'utf8').trim();
      if (raw === '') return null;
      const parsed = JSON.parse(raw);
      return typeof parsed?.url === 'string' && parsed.url.startsWith('http') ? parsed : null;
    } catch {
      return null;
    }
  }

  failureMessage(reason = 'plannotator exited before the review server was ready') {
    const detail = truncate(`${this.stderr}\n${this.stdout}`.trim(), 2_000);
    return detail === '' ? reason : `${reason}\n${detail}`;
  }

  /** The command result text shown to the human next to the command. */
  startText() {
    const lines = [
      `Plannotator review is open: ${this.url}`,
      `target: ${this.invocation.label}`,
      this.invocation.gate
        ? 'When you are done, press Approve or submit annotations in the browser tab.'
        : 'Submit annotations (or close the tab) in the browser tab when you are done.',
      'I keep working; your annotations will come back to me as a message.',
    ];
    if (this.invocation.open === false) {
      lines.splice(1, 0, '(browser auto-open is off — open the URL above yourself)');
    }
    return lines.join('\n');
  }

  /**
   * Parse the decision record from stdout and deliver it to the agent.
   *
   * @param {object|null} agent The originating agent, when the command had one.
   */
  settle(agent) {
    const decision = this.readDecision();
    const summary = describeDecision(decision, this);
    this.runtime.log(`session ${this.id} settle: ${summary}`);

    if (this.runtime.config.autoFollowup && agent && typeof agent.steer === 'function') {
      try {
        // `steer` takes a complete UserMessage. The host appends it to the
        // session log verbatim and builds the provider request from that record,
        // so every field the type requires has to travel with the payload:
        //  - `id` identifies the message. Host producers get one from
        //    `createUserMessage()` (`{ ...input, id: randomUUID() }`), and a plugin
        //    cannot reuse it: `@deepseek-ai/dsh-llm` resolves against this plugin's
        //    own directory, not the profile's node_modules. Mint it here instead.
        //    This one is not optional. The append path admits an unidentified
        //    message, but the restore path rejects the *whole session* on the next
        //    load with "session event at seq N lacks an identified message", so the
        //    history disappears after a restart.
        //  - `role` is what makes a later request fail with
        //    "messages[N]: missing field `role`" (HTTP 422) when absent.
        //  - Session format v4 retired the bare `kind: 'plugin'` + `plugin` pair:
        //    a plugin must stamp its own `plugin:<name>` kind, otherwise the turn is
        //    rejected with "format v4 message requires a producer-owned source kind".
        agent.steer({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: followupText(decision, this) }],
          source: { kind: `plugin:${NAME}` },
        });
        return;
      } catch (error) {
        this.runtime.log(`session ${this.id} steering failed: ${String(error?.message ?? error)}`);
      }
    }
    this.runtime.log(`session ${this.id} decision (not delivered): ${truncate(summary, 500)}`);
  }

  readDecision() {
    const trimmed = this.stdout.trim();
    if (trimmed === '') return null;
    const lastLine = trimmed.split('\n').reverse().find((line) => line.trim().startsWith('{'));
    if (!lastLine) return null;
    try {
      const parsed = JSON.parse(lastLine);
      if (parsed && typeof parsed.decision === 'string') {
        return { decision: parsed.decision, feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '' };
      }
    } catch {
      return null;
    }
    return null;
  }

  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.rmSync(this.scratch, { recursive: true, force: true });
    } catch {
      // Scratch cleanup is best effort.
    }
  }
}

function describeDecision(decision, session) {
  if (decision === null) {
    if (session.timedOut) return `no decision record (stopped after ${humanDuration(session.timeoutMs)})`;
    const failed = session.exitCode !== 0;
    return failed
      ? `no decision record (exit ${session.exitCode ?? 'signal ' + session.signal})`
      : 'no decision record (session ended without a decision)';
  }
  if (decision.decision === 'approved') return 'approved';
  if (decision.decision === 'dismissed') return 'dismissed without feedback';
  return `annotated (${decision.feedback.length} chars of feedback)`;
}

function followupText(decision, session) {
  const header = `Plannotator review of ${session.invocation.label} finished.`;
  if (decision === null) {
    const detail = truncate(`${session.stderr}\n${session.stdout}`.trim(), 1_000);
    return [
      header,
      session.timedOut
        ? `The review was still open after ${humanDuration(session.timeoutMs)}, so I stopped it.`
        : 'No decision record came back, so the review most likely ended without a submission or the process failed.',
      detail === '' ? '' : `Process output:\n${detail}`,
      'Ask me for a fresh review if you want another pass.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (decision.decision === 'approved') {
    return [
      header,
      'The reviewer approved.',
      decision.feedback === '' ? '' : `Notes carried with the approval:\n\n${truncate(decision.feedback, FEEDBACK_LIMIT)}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (decision.feedback.trim() === '') {
    return `${header}\n\nThe review session closed with no annotations and no decision. Say so briefly and continue.`;
  }
  return [
    header,
    'Annotations from the review — address them in this document:',
    '',
    truncate(decision.feedback, FEEDBACK_LIMIT),
  ].join('\n');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A short human duration for the timeout prose, so a sub-minute budget reads right. */
function humanDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(ms / 1_000))} seconds`;
}
