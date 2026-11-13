// Run with: node tests/sync.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Load pure functions from sync.js without requiring browser IndexedDB
const syncSrc = fs
  .readFileSync(new URL('../sync.js', import.meta.url), 'utf8')
  .replace(
    "import { getMeta, setMeta, loadAllUserState } from './db.js';",
    'const getMeta = async () => null, setMeta = async () => {}, loadAllUserState = async () => new Map();'
  );

const tmpUrl = new URL('./_sync_under_test.mjs', import.meta.url);
fs.writeFileSync(tmpUrl, syncSrc);

try {
  const {
    mergeUserStateFieldWise,
    mergeEventsBounded,
    validateBackupPayload,
    deflateB64,
    inflateB64,
  } = await import(tmpUrl.href);

  // 1. Two-device offline per-field LWW merge (Device A marks sid1; Device B adds note + result on sid1)
  const local = new Map([
    ['sid1', { sid: 'sid1', mark: { val: true, ts: 100, deleted: false }, note: { text: 'old', ts: 50 } }],
  ]);
  const remote = [
    { sid: 'sid1', note: { text: 'new note', ts: 200, deleted: false }, result: { pick: 'B', cor: 'B', ok: true, ts: 150 } },
  ];
  const merged = mergeUserStateFieldWise(local, remote);
  assert.equal(merged.get('sid1').mark.val, true);
  assert.equal(merged.get('sid1').note.text, 'new note');
  assert.equal(merged.get('sid1').result.pick, 'B');

  // 2. Bounded events (<= 500)
  const evA = Array.from({ length: 300 }, (_, i) => ({ eventId: `a-${i}`, ts: i }));
  const evB = Array.from({ length: 300 }, (_, i) => ({ eventId: `b-${i}`, ts: 300 + i }));
  const evMerged = mergeEventsBounded(evA, evB);
  assert.equal(evMerged.length, 500);
  assert.equal(evMerged[0].eventId, 'a-100');

  // 3. Corrupt / foreign / old-version backup rejection
  assert.throws(() => validateBackupPayload(null));
  assert.throws(() => validateBackupPayload({ schemaVersion: 99, userState: [], events: [] }));
  assert.throws(() => validateBackupPayload({ schemaVersion: 1, userState: 'bad' }));

  // 4. Deflate + base64url round-trip
  const round = await inflateB64(await deflateB64({ ok: true, n: 53873 }, true), true);
  assert.equal(round.n, 53873);

  console.log('ALL TESTS PASSED: per-field LWW merge, bounded events, backup validation, deflate-b64url round-trip.');
} finally {
  fs.unlinkSync(tmpUrl);
}