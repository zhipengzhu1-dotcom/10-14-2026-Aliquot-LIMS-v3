// Upgrade tests: start the current code against a database from an earlier release and check that the migrations
// apply, no records are lost and the audit trail's hash chain still verifies. Run before every release.
//
// Sources, each upgraded in a throwaway copy (the original is never opened for writing):
//   - every test/fixtures/*.db
//   - UPGRADE_FROM=<backup .db file, or a backup folder containing aliquot.db and files/>
// Run with:  npm test            or   UPGRADE_FROM=D:\Backups\Aliquot npm run test:upgrade

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from '../server/schema.js';
import { openDb, closeDb } from '../server/db.js';
import { verifyChain } from '../server/audit.js';
import { startServer } from './server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
// Rows in these tables expire on their own, so their counts may legitimately drop.
const TRANSIENT = new Set(['sessions', 'document_edit_links']);

const sources = [];
if (fs.existsSync(FIXTURES)) {
  for (const f of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.db')).sort()) sources.push(path.join(FIXTURES, f));
}
if (process.env.UPGRADE_FROM) sources.push(path.resolve(process.env.UPGRADE_FROM));

function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const counts = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      counts[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    }
    return { version, counts };
  } finally {
    db.close();
  }
}

if (!sources.length) {
  test('upgrade from a previous release', { skip: 'no fixtures in test/fixtures/ and UPGRADE_FROM is not set' }, () => {});
}

for (const source of sources) {
  const isFolder = fs.statSync(source).isDirectory();
  const dbFile = isFolder ? path.join(source, 'aliquot.db') : source;

  test(`upgrade ${path.basename(source)} to schema v${MIGRATIONS.length} without losing records`, async () => {
    assert.ok(fs.existsSync(dbFile), `No database at ${dbFile}`);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-upgrade-'));
    try {
      const copy = path.join(dataDir, 'aliquot.db');
      const original = new DatabaseSync(dbFile, { readOnly: true });
      original.prepare('VACUUM INTO ?').run(copy);
      original.close();
      if (isFolder && fs.existsSync(path.join(source, 'files'))) fs.cpSync(path.join(source, 'files'), path.join(dataDir, 'files'), { recursive: true });

      const before = snapshot(copy);
      assert.ok(before.version <= MIGRATIONS.length, `Database is at schema v${before.version}, newer than this code (v${MIGRATIONS.length})`);

      // Start the real server, exactly as a lab would after installing the new release.
      const server = await startServer(dataDir);
      await server.stop();

      const after = snapshot(copy);
      assert.equal(after.version, MIGRATIONS.length, 'all migrations applied');
      for (const [table, n] of Object.entries(before.counts)) {
        assert.ok(table in after.counts, `Table ${table} is missing after the upgrade. If it was renamed on purpose, update this test.`);
        if (!TRANSIENT.has(table)) assert.ok(after.counts[table] >= n, `${table}: ${n} rows before the upgrade, ${after.counts[table]} after`);
      }

      openDb(copy);
      try {
        const chain = verifyChain();
        assert.ok(chain.ok, `Audit trail hash chain broken at entry #${chain.brokenAt} after the upgrade`);
        assert.ok(chain.count >= before.counts.audit_log, 'audit entries preserved');
      } finally {
        closeDb();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test('a version 5 database gains append-only sample details, and its audit trail still verifies', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-upgrade-v5-'));
  try {
    let server = await startServer(dataDir);
    const setup = await fetch(`${server.base}/api/setup`, {
      method: 'POST', headers: { 'X-Requested-With': 'aliquot', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'demo' }),
    });
    assert.equal(setup.status, 200, server.log());
    await server.stop();

    const file = path.join(dataDir, 'aliquot.db');
    const v5 = new DatabaseSync(file);
    v5.exec('DROP TABLE intake_decisions; ALTER TABLE samples DROP COLUMN intake; DROP TABLE sample_details; PRAGMA user_version = 5');
    v5.close();
    const before = snapshot(file);
    assert.equal(before.version, 5);

    server = await startServer(dataDir);
    await server.stop();
    const after = snapshot(file);
    assert.equal(after.version, MIGRATIONS.length);
    assert.equal(after.counts.sample_details, 0);
    assert.equal(after.counts.samples, before.counts.samples);

    openDb(file);
    try {
      assert.ok(verifyChain().ok, 'audit trail verifies after the upgrade');
    } finally {
      closeDb();
    }
    const db = new DatabaseSync(file);
    try {
      const sample = db.prepare('SELECT id FROM samples LIMIT 1').get();
      db.prepare("INSERT INTO sample_details (sample_id, details, created_at) VALUES (?, '[]', '2026-10-16')").run(sample.id);
      assert.throws(() => db.prepare("UPDATE sample_details SET details = '[1]'").run(), /sample details are append-only/);
      assert.throws(() => db.prepare('DELETE FROM sample_details').run(), /sample details are append-only/);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a version 6 database gains intake review: every Sample is Accepted, stays assignable, and the audit trail still verifies', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliquot-upgrade-v6-'));
  const post = async (base, cookie, url, body) => {
    const res = await fetch(base + url, {
      method: 'POST', headers: { 'X-Requested-With': 'aliquot', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
    });
    return { res, data: await res.json() };
  };
  try {
    let server = await startServer(dataDir);
    assert.equal((await post(server.base, '', '/api/setup', { mode: 'demo' })).res.status, 200, server.log());
    await server.stop();

    const file = path.join(dataDir, 'aliquot.db');
    const v6 = new DatabaseSync(file);
    // The demo leaves its newest arrivals Pending review; once upgraded they must be assignable like every other Sample.
    const waiting = v6.prepare(`SELECT t.id, m.code AS method_code FROM tests t JOIN samples s ON s.id = t.sample_id JOIN methods m ON m.id = t.method_id
      WHERE s.intake = 'Pending review' AND t.analyst_id IS NULL AND t.status = 'Pending' ORDER BY t.id LIMIT 1`).get();
    assert.ok(waiting, 'the demo lab has a Test on a Sample Pending review');
    const qualified = v6.prepare(`SELECT u.id FROM qualifications q JOIN users u ON u.id = q.user_id
      WHERE q.method_code = ? AND q.revoked = 0 AND u.active = 1 AND u.role IN ('analyst', 'scientist') ORDER BY u.id LIMIT 1`).get(waiting.method_code);
    assert.ok(qualified, 'someone is qualified on that Method');
    v6.exec('DROP TABLE intake_decisions; ALTER TABLE samples DROP COLUMN intake; PRAGMA user_version = 6');
    v6.close();
    const before = snapshot(file);
    assert.equal(before.version, 6);

    server = await startServer(dataDir);
    try {
      const after = snapshot(file);
      assert.equal(after.version, MIGRATIONS.length);
      assert.equal(after.counts.samples, before.counts.samples);
      assert.equal(after.counts.intake_decisions, 0);

      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM samples WHERE intake != 'Accepted'").get().n, 0, 'every existing Sample is Accepted');
        const login = await post(server.base, '', '/api/auth/login', { username: 'priya.raman', password: 'demo1234' });
        const cookie = login.res.headers.get('set-cookie').split(';')[0];
        const assigned = await post(server.base, cookie, '/api/tests/assign', { test_ids: [waiting.id], analyst_id: qualified.id });
        assert.equal(assigned.res.status, 200, `a Sample from before the upgrade is not held back by intake review: ${JSON.stringify(assigned.data)}`);
      } finally {
        db.close();
      }
    } finally {
      await server.stop();
    }

    openDb(file);
    try {
      assert.ok(verifyChain().ok, 'audit trail verifies after the upgrade');
    } finally {
      closeDb();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
