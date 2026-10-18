// Stands in for the `claude` command in tests, so no test ever reaches a model. Point ALIQUOT_CLAUDE_BIN at this file
// and FAKE_CLAUDE_DIR at a folder holding:
//   signed-out     present: `auth status` reports no account
//   replies.json   the answers to `-p` calls, in order; the last repeats. Each is { output } for a structured answer,
//                  { raw, exit } for what a broken CLI prints, and may add delay_ms, and ignore_term to outlast a
//                  SIGTERM. The answer names the model it was asked for in modelUsage, or { answered_by } instead.
//                  With { stream: ["I drafted", " one lot."], stream_delay_ms } the reply's words come first, a piece
//                  at a time, before the delay and the answer.
// Every call is appended to calls.jsonl as { args, cwd, input, start, end } when it answers, and a `-p` call also as
// { args, cwd, pid, start } when it starts and { ..., term: true } when it gets a SIGTERM.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_CLAUDE_DIR;
const args = process.argv.slice(2);
const calls = path.join(dir, 'calls.jsonl');
const start = Date.now();
const record = (entry) => fs.appendFileSync(calls, `${JSON.stringify({ args, cwd: process.cwd(), ...entry, start, end: Date.now() })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === 'auth' && args[1] === 'status') {
  const signedIn = !fs.existsSync(path.join(dir, 'signed-out'));
  record({});
  process.stdout.write(JSON.stringify(signedIn
    ? { loggedIn: true, authMethod: 'claude.ai', email: 'lab@example.com', subscriptionType: 'max' }
    : { loggedIn: false, authMethod: 'none' }));
  process.exit(signedIn ? 0 : 1);
}

const input = fs.readFileSync(0, 'utf8');
const done = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('"input"')).length : 0;
const replies = JSON.parse(fs.readFileSync(path.join(dir, 'replies.json'), 'utf8'));
const reply = replies[Math.min(done, replies.length - 1)];
record({ pid: process.pid });
if (reply.ignore_term) process.on('SIGTERM', () => record({ pid: process.pid, term: true }));
if (reply.stream) {
  line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'StructuredOutput', input: {} } } });
  const pieces = ['{"reply": "', ...reply.stream.map((s) => JSON.stringify(s).slice(1, -1)), '", "draft": {}}'];
  for (const partial_json of pieces) {
    line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } } });
    if (reply.stream_delay_ms) await sleep(reply.stream_delay_ms);
  }
}
if (reply.delay_ms) await sleep(reply.delay_ms);
record({ input });
if ('raw' in reply) {
  process.stdout.write(reply.raw);
  process.exit(reply.exit ?? 1);
}
line({
  type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(reply.output), structured_output: reply.output,
  modelUsage: { 'claude-haiku-4-5': { outputTokens: 3 }, [reply.answered_by ?? args[args.indexOf('--model') + 1]]: { outputTokens: 400 } },
});
