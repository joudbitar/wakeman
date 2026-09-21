// Log-rotation tests for the daemon's rotateIfNeeded helper.
//
// Proves that a log file past the size threshold rotates (x.log -> x.log.1),
// that a second rotation shifts generations up, that at most `keep` rotated
// generations survive (older ones pruned), that the real 1 MB default boundary
// uses >= semantics, and that sub-threshold / missing / undirected paths are
// safe no-ops that never throw. Pure node:test + node:assert against files in
// an ephemeral temp dir — no servers, ports, real projects, or network, so
// fully deterministic. rotateIfNeeded takes an explicit `file` arg, so tests
// touch only their throwaway dir and never the real LOGS_DIR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rotateIfNeeded } from '../xerb.mjs';

// Fresh temp dir per test, removed in t.after. Returns { dir, file } where
// `file` is the log path inside it (not yet created).
function tmpLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerb-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'x.log') };
}

// Write `content`, padded with 'A' up to at least `size` bytes, to `file`.
function writeAtLeast(file, content, size) {
  const pad = Math.max(0, size - Buffer.byteLength(content));
  fs.writeFileSync(file, content + 'A'.repeat(pad));
}

test('rotates past threshold and shifts on the second rotation', (t) => {
  const { file } = tmpLog(t);
  const maxBytes = 1024;

  // First generation: content past threshold, then rotate.
  writeAtLeast(file, 'GEN0\n', maxBytes);
  rotateIfNeeded(file, maxBytes);
  assert.equal(fs.existsSync(file), false, 'original file should be gone after rotation');
  assert.equal(fs.existsSync(`${file}.1`), true, 'x.log.1 should exist after rotation');
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^GEN0/, 'x.log.1 should hold GEN0');

  // Second generation: fresh file, rotate again -> shift GEN0 down to .2.
  writeAtLeast(file, 'GEN1\n', maxBytes);
  rotateIfNeeded(file, maxBytes);
  assert.equal(fs.existsSync(file), false, 'original file should be gone after second rotation');
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^GEN1/, 'x.log.1 should now hold GEN1 (newest)');
  assert.match(fs.readFileSync(`${file}.2`, 'utf8'), /^GEN0/, 'x.log.2 should hold GEN0 (shifted)');
});

test('real 1 MB default: 1_000_000 rotates, 999_999 does not (>= semantics)', (t) => {
  const { file } = tmpLog(t);

  // Exactly the default threshold -> rotates (>= maxBytes).
  writeAtLeast(file, 'BIG\n', 1_000_000);
  rotateIfNeeded(file); // no maxBytes arg -> default 1_000_000
  assert.equal(fs.existsSync(file), false, '1_000_000-byte file should rotate at the default');
  assert.equal(fs.existsSync(`${file}.1`), true, 'x.log.1 should exist after default rotation');

  // One byte under the threshold -> untouched.
  const { file: small } = tmpLog(t);
  writeAtLeast(small, 'SMALL\n', 999_999);
  rotateIfNeeded(small);
  assert.equal(fs.existsSync(small), true, '999_999-byte file should NOT rotate');
  assert.equal(fs.existsSync(`${small}.1`), false, 'no x.log.1 for a sub-threshold file');
});

test('keeps at most `keep` generations, prunes older, newest is .1', (t) => {
  const { file } = tmpLog(t);
  const maxBytes = 1024;
  const keep = 3;

  // Rotate keep + 2 times, embedding an incrementing generation marker so we
  // can assert ordering afterwards.
  for (let g = 0; g < keep + 2; g++) {
    writeAtLeast(file, `GEN${g}\n`, maxBytes);
    rotateIfNeeded(file, maxBytes, keep);
  }

  // After the last rotation the writer has not recreated `file`, so it is absent.
  assert.equal(fs.existsSync(file), false, 'current x.log absent after final rotation');

  // Exactly `keep` rotated generations survive; .4 and beyond are pruned.
  assert.equal(fs.existsSync(`${file}.1`), true, 'x.log.1 kept');
  assert.equal(fs.existsSync(`${file}.2`), true, 'x.log.2 kept');
  assert.equal(fs.existsSync(`${file}.3`), true, 'x.log.3 kept');
  assert.equal(fs.existsSync(`${file}.4`), false, 'x.log.4 pruned');
  assert.equal(fs.existsSync(`${file}.5`), false, 'x.log.5 absent');

  // Count of existing rotated generations is <= keep.
  const survivors = [1, 2, 3, 4, 5].filter((i) => fs.existsSync(`${file}.${i}`));
  assert.ok(survivors.length <= keep, `at most ${keep} generations kept (got ${survivors.length})`);

  // Ordering: last write was GEN4 (newest) -> .1; oldest survivor is GEN2 -> .3.
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^GEN4/, 'x.log.1 is newest (GEN4)');
  assert.match(fs.readFileSync(`${file}.2`, 'utf8'), /^GEN3/, 'x.log.2 is GEN3');
  assert.match(fs.readFileSync(`${file}.3`, 'utf8'), /^GEN2/, 'x.log.3 is oldest survivor (GEN2)');
});

test('no-op when the file is missing or sub-threshold', (t) => {
  const { dir, file } = tmpLog(t);

  // Missing file: no throw, nothing created.
  assert.doesNotThrow(() => rotateIfNeeded(file, 1024));
  assert.equal(fs.existsSync(file), false, 'missing file stays missing');
  assert.equal(fs.existsSync(`${file}.1`), false, 'no x.log.1 created for a missing file');
  assert.deepEqual(fs.readdirSync(dir), [], 'temp dir stays empty');

  // Sub-threshold file: untouched, no rotation.
  writeAtLeast(file, 'tiny\n', 10);
  rotateIfNeeded(file, 1024);
  assert.equal(fs.existsSync(file), true, 'sub-threshold file left in place');
  assert.equal(fs.existsSync(`${file}.1`), false, 'no x.log.1 for a sub-threshold file');
  assert.match(fs.readFileSync(file, 'utf8'), /^tiny/, 'sub-threshold content unchanged');
});

test('best-effort: rotating a path inside a nonexistent dir never throws', (t) => {
  const { dir } = tmpLog(t);
  const bogus = path.join(dir, 'does', 'not', 'exist', 'x.log');
  // The parent directory does not exist, so any stat/rename would error; the
  // helper must swallow it and return without throwing.
  assert.doesNotThrow(() => rotateIfNeeded(bogus, 1024));
});
