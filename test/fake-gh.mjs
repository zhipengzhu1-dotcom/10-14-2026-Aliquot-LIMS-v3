// Stands in for the `gh` command in test/ci-watch.test.js, so no test reaches GitHub. A `gh` script on PATH runs this
// file with FAKE_GH_DIR set to a folder holding scenario.json:
//   prs      the answers to `pr view`, one per poll, in order; the last repeats.
//   runs     the answer to `run list`.
//   log      the answer to `run view --log-failed`.
//   merges   the exit codes of `pr merge`, in order; the last repeats.
// Every call is appended to calls.jsonl as its argv.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
const count = (name) => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter((l) => l.startsWith(`["${name[0]}","${name[1]}"`)).length - 1;
const pick = (list, i) => list[Math.min(i, list.length - 1)];

const [a, b] = args;
if (a === 'pr' && b === 'view') process.stdout.write(JSON.stringify(pick(scenario.prs, count(['pr', 'view']))));
else if (a === 'run' && b === 'list') process.stdout.write(JSON.stringify(scenario.runs ?? []));
else if (a === 'run' && b === 'view' && args.includes('--log-failed')) process.stdout.write(scenario.log ?? '');
else if (a === 'run' && b === 'view') process.stdout.write(JSON.stringify({ jobs: [] }));
else if (a === 'pr' && b === 'merge') {
  const code = pick(scenario.merges ?? [0], count(['pr', 'merge']));
  if (code) process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n');
  process.exit(code);
} else {
  process.stderr.write(`fake gh: no answer for ${args.join(' ')}\n`);
  process.exit(1);
}
