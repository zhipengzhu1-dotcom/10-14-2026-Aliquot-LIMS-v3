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
const MAX_REPLY_JSON = 16 * 1024;

export const unavailable = (reason) => new HttpError(503, reason, 'ASSISTANT_UNAVAILABLE');

// The claude command reads CLAUDE.md and project files from its working directory and the folders above it, so it runs
// in an empty folder of its own, outside Aliquot's.
let emptyDir = null;
const workDir = () => {
  if (!emptyDir || !fs.existsSync(emptyDir)) emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-claude-'));
  return emptyDir;
};

/**
 * Runs the claude command with `args` (never through a shell), `input` on stdin. Resolves to its exit code and output,
 * or hands each line of output to `onLine` as it arrives instead of keeping it. One that runs past `timeoutMs` is
 * stopped, killed outright if it ignores that, and refused once it has exited.
 */
function run(args, { input = '', timeoutMs, onLine }) {
  const named = process.env.ALIQUOT_CLAUDE_BIN || 'claude';
  const bin = named.includes('/') || named.includes(path.sep) ? path.resolve(named) : named;
  // A script path runs under this Node, so the tests' stand-in works on every platform.
  const [cmd, pre] = /\.m?js$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], { cwd: workDir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
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
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (!onLine) {
        if (stdout.length < MAX_OUTPUT) stdout += d;
        return;
      }
      if (pending.length < MAX_OUTPUT) pending += d;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (onLine && pending) onLine(pending);
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

const REPLY_KEY = /"reply"\s*:\s*"/;

/** The `reply` string as far as the model's partial JSON `json` has written it, decoded, or null while it cannot be read. */
export function partialReply(json) {
  const at = REPLY_KEY.exec(json);
  if (!at) return null;
  const from = at.index + at[0].length;
  let end = from;
  while (end < json.length && json[end] !== '"') {
    const step = json[end] !== '\\' ? 1 : json[end + 1] === 'u' ? 6 : 2;
    if (end + step > json.length) break;
    end += step;
  }
  const raw = json.slice(from, end);
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}

/**
 * One answer from `model` at `effort`, shaped by the JSON Schema `schema`. The model gets no tools and no settings, so it
 * can only answer. Resolves to { output, model, ms }: `output` is the structured answer or null when there was none,
 * `model` the one that answered. The reply's words go to `onText` as they grow, before the answer is complete. A call
 * that fails to reach Claude is refused as unavailable.
 */
export async function askClaude({ system, prompt, schema, model, effort, onText }) {
  await takeSlot();
  const started = Date.now();
  try {
    let result = null;
    let noise = '';
    let json = '';
    let said = '';
    const onLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        noise ||= line;
        return;
      }
      if (event.type === 'result') result = event;
      if (event.type !== 'stream_event' || !onText) return;
      // Each tool call is its own JSON; only its head can hold the reply, so the rest of a long draft is not scanned.
      if (event.event?.type === 'content_block_start') [json, said] = ['', ''];
      const delta = event.event?.delta;
      if (delta?.type !== 'input_json_delta' || json.length > MAX_REPLY_JSON) return;
      json += delta.partial_json;
      const text = partialReply(json);
      if (text !== null && text !== said) onText((said = text));
    };
    const { code, stderr } = await run([
      '-p', '--model', model, '--effort', effort,
      '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
      '--system-prompt', system, '--json-schema', JSON.stringify(schema),
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ], { input: prompt, timeoutMs: Number(process.env.ALIQUOT_CLAUDE_TIMEOUT_MS) || ANSWER_TIMEOUT_MS, onLine });
    if (!result) throw unavailable(`Claude could not be reached: ${firstLine(stderr || noise) || `the claude command exited with ${code}`}`);
    if (result.is_error) throw unavailable(`Claude could not answer: ${firstLine(result.result) || result.subtype || 'unknown error'}`);
    const usage = Object.entries(result.modelUsage ?? {}).sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0));
    const output = result.structured_output && typeof result.structured_output === 'object' ? result.structured_output : null;
    return { output, model: usage[0]?.[0] ?? model, ms: Date.now() - started };
  } finally {
    releaseSlot();
  }
}
