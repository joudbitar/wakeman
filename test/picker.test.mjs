// Pure-half tests for the scan picker (lib/picker.mjs): key bytes to actions,
// action to next state, state to lines. The IO shell (runPicker) is a thin
// wrapper over these; the one behavior tested there is the non-TTY fallback,
// because a picker that blocks a pipe would hang CI and the daemon's rescans.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeState, decodeKey, reduceKey, renderLines, scrollTop, runPicker } from '../lib/picker.mjs';
import { makeStyler } from '../lib/ui.mjs';

// isTTY false -> every style function is identity, so rendered lines are
// plain strings and assertions can read them.
const plain = makeStyler({ isTTY: false });

const items = (n) => Array.from({ length: n }, (_, i) => ({ label: `p${i}`, hint: `h${i}` }));

// --- state ------------------------------------------------------------------

test('makeState selects everything by default', () => {
  const s = makeState(items(3));
  assert.deepEqual(s.items.map((i) => i.selected), [true, true, true]);
  assert.equal(s.cursor, 0);
});

test('up/down move and wrap at both ends', () => {
  let s = makeState(items(3));
  s = reduceKey(s, 'up').state;
  assert.equal(s.cursor, 2, 'up from the top wraps to the bottom');
  s = reduceKey(s, 'down').state;
  assert.equal(s.cursor, 0, 'down from the bottom wraps to the top');
});

test('toggle flips only the cursor row', () => {
  let s = makeState(items(3));
  s = reduceKey(s, 'down').state;
  s = reduceKey(s, 'toggle').state;
  assert.deepEqual(s.items.map((i) => i.selected), [true, false, true]);
});

test('a selects all when mixed, deselects all when everything is on', () => {
  let s = makeState(items(3));
  s = reduceKey(s, 'toggle').state; // mixed
  s = reduceKey(s, 'all').state;
  assert.deepEqual(s.items.map((i) => i.selected), [true, true, true]);
  s = reduceKey(s, 'all').state;
  assert.deepEqual(s.items.map((i) => i.selected), [false, false, false]);
});

test('confirm and cancel end the interaction, other keys do not', () => {
  const s = makeState(items(2));
  assert.equal(reduceKey(s, 'confirm').done, 'confirm');
  assert.equal(reduceKey(s, 'cancel').done, 'cancel');
  assert.equal(reduceKey(s, 'down').done, undefined);
  assert.equal(reduceKey(s, 'nonsense').done, undefined);
});

// --- key decoding -----------------------------------------------------------

test('decodeKey maps the whole keyboard contract', () => {
  assert.equal(decodeKey(Buffer.from('\x1b[A')), 'up');
  assert.equal(decodeKey(Buffer.from('k')), 'up');
  assert.equal(decodeKey(Buffer.from('\x1b[B')), 'down');
  assert.equal(decodeKey(Buffer.from('j')), 'down');
  assert.equal(decodeKey(Buffer.from(' ')), 'toggle');
  assert.equal(decodeKey(Buffer.from('a')), 'all');
  assert.equal(decodeKey(Buffer.from('\r')), 'confirm');
  assert.equal(decodeKey(Buffer.from('q')), 'cancel');
  assert.equal(decodeKey(Buffer.from('\x1b')), 'cancel', 'bare escape backs out');
  assert.equal(decodeKey(Buffer.from('\x03')), 'abort', 'Ctrl-C aborts the scan');
  assert.equal(decodeKey(Buffer.from('x')), null, 'unmapped keys are ignored');
});

// --- rendering --------------------------------------------------------------

test('renders every row with cursor and checkbox state', () => {
  let s = makeState(items(3));
  s = reduceKey(s, 'down').state;
  s = reduceKey(s, 'toggle').state;
  const lines = renderLines(s, { styler: plain });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /◉ p0/);
  assert.match(lines[1], /❯ ◯ p1/, 'cursor row, deselected');
  assert.match(lines[2], /◉ p2/);
  assert.ok(!lines[0].includes('❯'), 'only the cursor row carries the marker');
});

test('long lists keep one height: a window of rows plus one position line', () => {
  let s = makeState(items(20));
  const at = (st) => renderLines(st, { styler: plain, maxVisible: 5 });
  assert.equal(at(s).length, 6);
  assert.match(at(s)[5], / ↓ 1–5 of 20/);
  for (let i = 0; i < 10; i += 1) s = reduceKey(s, 'down').state;
  assert.equal(at(s).length, 6, 'the frame never grows or shrinks');
  assert.match(at(s)[5], /↑↓ \d+–\d+ of 20/);
  assert.ok(at(s).some((l) => l.includes('❯ ◉ p10')), 'cursor row stays in the window');
});

test('the window scrolls at the edges, not on every key', () => {
  // 20 items, 8 visible, 2 rows of lookahead: rows 0-5 move the cursor only.
  let top = 0;
  for (let c = 0; c <= 5; c += 1) top = scrollTop(top, c, 20, 8);
  assert.equal(top, 0, 'moving through the middle holds the list still');
  assert.equal(scrollTop(top, 6, 20, 8), 1, 'two rows from the bottom edge, it scrolls one');
  assert.equal(scrollTop(5, 9, 20, 8), 5, 'coming back up inside the window holds still too');
  assert.equal(scrollTop(5, 6, 20, 8), 4);
  assert.equal(scrollTop(0, 19, 20, 8), 12, 'wrapping to the end lands on the last window');
  assert.equal(scrollTop(12, 0, 20, 8), 0, 'and wrapping back lands on the first');
  assert.equal(scrollTop(3, 2, 5, 8), 0, 'a list that fits never scrolls');
});

test('hints truncate to the terminal width before styling', () => {
  const s = makeState([{ label: 'p', hint: 'x'.repeat(200) }]);
  const [line] = renderLines(s, { styler: plain, width: 40 });
  assert.ok(line.length <= 40, `line fits in 40 cols, got ${line.length}`);
  assert.match(line, /…$/);
});

// --- IO shell ---------------------------------------------------------------

test('runPicker without a TTY selects everything and never prompts', async () => {
  const res = await runPicker({
    items: items(3),
    styler: plain,
    stdin: { isTTY: false },
    stdout: { isTTY: false },
  });
  assert.deepEqual(res, { cancelled: false, selected: [true, true, true] });
});

// --- "not now" ends the run -------------------------------------------------
//
// q and Esc used to resolve { cancelled: true } and let the scan carry on:
// pressing q reported "found 0 projects", then "no projects found under ~",
// then booted anyway. They now end the process, so both halves of that
// contract need a child: the exit code, and that nothing was written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CANCEL_EXIT } from '../lib/picker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Run `script` in a child, feeding `keys` to its stdin once `ready` shows up in
// its output. Resolves { code, out }.
function drive(argv, env, keys, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let sent = false;
    const onChunk = (d) => {
      out += d;
      if (!sent && out.includes(ready)) {
        sent = true;
        child.stdin.write(keys);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
    setTimeout(() => child.kill('SIGKILL'), 20000).unref?.();
  });
}

test('q exits the whole run with one line, and never resolves', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-picker-'));
  const driver = path.join(tmp, 'driver.mjs');
  fs.writeFileSync(driver, `
import { runPicker } from ${JSON.stringify(path.join(ROOT, 'lib', 'picker.mjs'))};
import { makeStyler } from ${JSON.stringify(path.join(ROOT, 'lib', 'ui.mjs'))};
const styler = makeStyler({ isTTY: false });
const fake = {
  isTTY: true, isRaw: false, columns: 80,
  setRawMode() {}, resume() {}, pause() {},
  on(ev, fn) { if (ev === 'data') this._fn = fn; },
  off() {},
  write(s) { process.stdout.write(s); },
};
runPicker({ items: [{ label: 'one' }], styler, stdin: fake, stdout: fake })
  .then(() => process.stdout.write('RESOLVED\\n'));
process.stdout.write('READY\\n');
setTimeout(() => fake._fn(Buffer.from('q')), 10);
`);
  const r = await drive([driver], { ...process.env, NO_COLOR: '1' }, '', 'READY');
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.code, CANCEL_EXIT, 'the run ends with the back-out code, not 0 or 130');
  assert.match(r.out, /ok, nothing registered\. run `wakeman` again whenever\./);
  assert.ok(!r.out.includes('RESOLVED'), 'the caller never gets a value to carry on with');
});

test('q in a real scan writes no registry and remembers nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeman-picker-scan-'));
  const home = path.join(tmp, 'home');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(state, { recursive: true });
  const proj = path.join(home, 'siteapp');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'siteapp', scripts: { dev: 'vite dev' }, devDependencies: { vite: '5' } })
  );

  // scan.mjs raises the picker only when both ends are a terminal, and
  // runPicker then puts stdin in raw mode. A pipe is neither, so the child is
  // told it is a tty before scan.mjs reads process.stdin — the pipe itself is
  // still what carries the keypress.
  const stub = path.join(tmp, 'tty.mjs');
  fs.writeFileSync(stub, `
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = () => {};
`);

  const r = await drive(
    ['--import', `file://${stub}`, path.join(ROOT, 'scan.mjs')],
    { ...process.env, HOME: home, WAKEMAN_STATE_DIR: state, NO_COLOR: '1' },
    'q',
    'siteapp'
  );
  const wrote = fs.existsSync(path.join(state, 'projects.json'));
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.code, CANCEL_EXIT);
  assert.match(r.out, /ok, nothing registered/);
  assert.equal(wrote, false, 'no registry written, so nothing was registered and nothing declined');
});

test('chips sit before the label, labels share a column, unrevealed rows stay blank', () => {
  const s = makeState([
    { label: 'shop', hint: '~/code/shop', chip: { text: '[vite]  ', width: 8 } },
    { label: 'portfolio', hint: '~/code/portfolio', chip: { text: '[next]  ', width: 8 } },
  ]);
  const plain = { bold: (x) => x, dim: (x) => x, cyan: (x) => x };
  assert.deepEqual(renderLines(s, { styler: plain }), [
    '  ❯ ◉ [vite]   shop       ~/code/shop',
    '    ◉ [next]   portfolio  ~/code/portfolio',
  ]);
  assert.deepEqual(renderLines(s, { styler: plain, revealed: 1 })[1], '');
});
