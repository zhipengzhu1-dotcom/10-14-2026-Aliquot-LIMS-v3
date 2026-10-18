// Stands in for the `claude` command in tests, so no test ever reaches a model. Point ALIQUOT_CLAUDE_BIN at this file
// and FAKE_CLAUDE_DIR at a folder holding:
//   signed-out     present: `auth status` reports no account
//   replies.json   the answers to `-p` calls, in order; the last repeats. Each is { output } for a structured answer,
//                  { raw, exit } for what a broken CLI prints, and may add delay_ms.
// Every call is appended to calls.jsonl as { args, input, start, end }.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_CLAUDE_DIR;
const args = process.argv.slice(2);
const calls = path.join(dir, 'calls.jsonl');
const start = Date.now();
const record = (entry) => fs.appendFileSync(calls, `${JSON.stringify({ args, ...entry, start, end: Date.now() })}\n`);

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
if (reply.delay_ms) await new Promise((resolve) => setTimeout(resolve, reply.delay_ms));
record({ input });
if ('raw' in reply) {
  process.stdout.write(reply.raw);
  process.exit(reply.exit ?? 1);
}
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(reply.output), structured_output: reply.output,
  modelUsage: { 'claude-haiku-4-5': { outputTokens: 3 }, 'claude-opus-5-5': { outputTokens: 400 } },
}));
