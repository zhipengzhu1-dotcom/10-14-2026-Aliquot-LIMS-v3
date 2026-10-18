// The one place that knows how Aliquot reaches Claude: the `claude` command on this computer, signed in to the user's
// own Claude subscription. Nothing about the account is stored in Aliquot. Moving to an API key changes this file only.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './http.js';

const MAX_RUNNING = 2;
const MAX_WAITING = 8;
const ANSWER_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export const unavailable = (reason) => new HttpError(503, reason, 'ASSISTANT_UNAVAILABLE');

// The claude command reads CLAUDE.md and project files from its working directory and the folders above it, so it runs
// in an empty folder of its own, outside Aliquot's.
let emptyDir = null;
const workDir = () => {
  if (!emptyDir || !fs.existsSync(emptyDir)) emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-claude-'));
  return emptyDir;
};

/**
 * Runs the claude command with `args` (never through a shell), `input` on stdin. Resolves to its exit code and output.
 * One that runs past `timeoutMs` is stopped, killed outright if it ignores that, and refused once it has exited.
 */
function run(args, { input = '', timeoutMs }) {
  const named = process.env.ALIQUOT_CLAUDE_BIN || 'claude';
  const bin = named.includes('/') || named.includes(path.sep) ? path.resolve(named) : named;
  // A script path runs under this Node, so the tests' stand-in works on every platform.
  const [cmd, pre] = /\.m?js$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], { cwd: workDir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(unavailable(e.code === 'ENOENT' ? `The claude command was not found on the computer that runs Aliquot (${bin}).` : `The claude command could not start: ${e.message}`));
    });
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (timedOut) reject(unavailable(`Claude did not answer within ${Math.round(timeoutMs / 1000)} seconds.`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

let running = 0;
const waiting = [];

async function takeSlot() {
  if (running < MAX_RUNNING) {
    running++;
    return;
  }
  if (waiting.length >= MAX_WAITING) throw unavailable('The assistant is busy. Try again in a minute.');
  await new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

const firstLine = (text) => String(text ?? '').trim().split('\n')[0].slice(0, 300);

/** The Claude account signed in on this computer: { loggedIn, email, method, plan }. */
export async function claudeAccount() {
  const { stdout, stderr } = await run(['auth', 'status'], { timeoutMs: STATUS_TIMEOUT_MS });
  let status;
  try {
    status = JSON.parse(stdout);
  } catch {
    throw unavailable(`The claude command did not report its sign-in: ${firstLine(stderr || stdout) || 'no output'}`);
  }
  return { loggedIn: status.loggedIn === true, email: status.email ?? null, method: status.authMethod ?? null, plan: status.subscriptionType ?? null };
}

/**
 * One answer from `model` at `effort`, shaped by the JSON Schema `schema`. The model gets no tools and no settings, so it
 * can only answer. Resolves to { output, model, ms }: `output` is the structured answer or null when there was none,
 * `model` the one that answered. A call that fails to reach Claude is refused as unavailable.
 */
export async function askClaude({ system, prompt, schema, model, effort }) {
  await takeSlot();
  const started = Date.now();
  try {
    const { code, stdout, stderr } = await run([
      '-p', '--model', model, '--effort', effort,
      '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
      '--system-prompt', system, '--json-schema', JSON.stringify(schema), '--output-format', 'json',
    ], { input: prompt, timeoutMs: Number(process.env.ALIQUOT_CLAUDE_TIMEOUT_MS) || ANSWER_TIMEOUT_MS });
    let reply;
    try {
      reply = JSON.parse(stdout);
    } catch {
      throw unavailable(`Claude could not be reached: ${firstLine(stderr || stdout) || `the claude command exited with ${code}`}`);
    }
    if (reply.is_error) throw unavailable(`Claude could not answer: ${firstLine(reply.result) || reply.subtype || 'unknown error'}`);
    const usage = Object.entries(reply.modelUsage ?? {}).sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0));
    const output = reply.structured_output && typeof reply.structured_output === 'object' ? reply.structured_output : null;
    return { output, model: usage[0]?.[0] ?? model, ms: Date.now() - started };
  } finally {
    releaseSlot();
  }
}
