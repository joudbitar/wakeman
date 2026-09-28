// Spinner behavior under a live event loop. The regression this locks in: the
// install phase once ran spawnSync/cpSync under the spinner, which starved the
// redraw interval and froze the animation on its first frame. The spinner must
// visibly advance while the awaited work yields, and stay silent on pipes.
// Pure node:test + node:assert, fake stream, no TTY, no timers beyond ~300ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSpinner, makeStyler } from '../lib/ui.mjs';

function fakeStream() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(String(s)) };
}

const FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

test('spinner advances through distinct frames while awaited work yields', async () => {
  const stream = fakeStream();
  const styler = makeStyler({ isTTY: false }); // plain text, frames still written
  const spin = makeSpinner({ isTTY: true, styler, minMs: 0, intervalMs: 20, stream });
  spin.start('installing the LaunchAgent');
  await new Promise((r) => setTimeout(r, 200));
  await spin.done('done');
  const frames = stream.chunks.join('').match(FRAME_RE) || [];
  assert.ok(new Set(frames).size >= 3, `expected several distinct frames, saw: ${[...new Set(frames)].join(' ')}`);
});

test('spinner stays frame-free when not a TTY', async () => {
  const stream = fakeStream();
  const styler = makeStyler({ isTTY: false });
  const spin = makeSpinner({ isTTY: false, styler, minMs: 0, intervalMs: 20, stream });
  spin.start('scanning');
  await new Promise((r) => setTimeout(r, 60));
  await spin.done('final line');
  const outText = stream.chunks.join('');
  assert.equal(outText.match(FRAME_RE), null, 'no braille frames on a pipe');
  assert.ok(outText.includes('final line'), 'only the final line prints');
  assert.ok(!outText.includes('\r'), 'no carriage returns on a pipe');
});

test('done() waits out minMs so a fast phase still shows its work', async () => {
  const stream = fakeStream();
  const styler = makeStyler({ isTTY: false });
  const spin = makeSpinner({ isTTY: true, styler, minMs: 120, intervalMs: 20, stream });
  const before = Date.now();
  spin.start('quick phase');
  await spin.done('held');
  assert.ok(Date.now() - before >= 110, 'done() holds until minMs has passed');
});

test('columnize reads down each column and pads on plain width, not painted width', async () => {
  const { columnize } = await import('../lib/ui.mjs');
  const { lines, hidden } = columnize(['a', 'bb', 'ccc', 'dddd', 'e'], { width: 80, paint: (s) => `<${s}>` });
  assert.deepEqual(lines, ['  <a>       <dddd>', '  <bb>      <e>', '  <ccc>']);
  assert.equal(hidden, 0);
});

test('columnize falls back to one column when two do not fit, and reports what it cut', async () => {
  const { columnize } = await import('../lib/ui.mjs');
  const narrow = columnize(['http://portfolio.localhost', 'http://shop.localhost'], { width: 40 });
  assert.deepEqual(narrow.lines, ['  http://portfolio.localhost', '  http://shop.localhost']);
  const cut = columnize(['a', 'b', 'c', 'd', 'e'], { maxRows: 2 });
  assert.equal(cut.lines.length, 2);
  assert.equal(cut.hidden, 1);
  assert.deepEqual(columnize([]), { lines: [], hidden: 0 });
});

test('framework chips: plain text on a pipe, cube colors without COLORTERM, 24-bit with it', async () => {
  const { frameworkChip, chipWidth, frameworkTally } = await import('../lib/ui.mjs');
  const plain = makeStyler({ isTTY: false });
  assert.equal(frameworkChip('vite', plain, chipWidth(['vite', 'sveltekit'])), ' vite      ');
  assert.equal(frameworkTally(['next', 'vite', 'next', 'static'], plain), '2 next · 1 static · 1 vite');
  assert.match(frameworkChip('vite', makeStyler({ isTTY: true, env: {} })), /^\x1b\[48;5;\d+;38;5;\d+m vite \x1b\[39;49m$/);
  assert.match(frameworkChip('vite', makeStyler({ isTTY: true, env: { COLORTERM: 'truecolor' } })), /^\x1b\[48;2;100;108;255;/);
  // An unknown framework still gets a chip, never a throw.
  assert.equal(frameworkChip('phoenix', plain), ' phoenix ');
});
