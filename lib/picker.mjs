// Interactive multi-select for the scanner: newly found projects, one
// checkbox each, so registering is a choice instead of a surprise. Zero deps,
// raw-mode ANSI only. Everything decidable without a terminal — key bytes to
// actions, action to next state, state to lines — is pure and exported for
// tests; runPicker is the thin IO shell around them.
//
// Keys: ↑/↓ (or k/j) move, space toggles, `a` toggles everything, enter
// confirms, q or esc backs out, Ctrl-C aborts the whole scan with exit 130
// before anything is written.
//
// "Backs out" means the RUN ends, not just the prompt: q/Esc prints one line
// and exits the process with CANCEL_EXIT. The picker only ever runs inside a
// scan whose remaining work is writing a registry the user just declined to
// change, so continuing past a "not now" was how pressing q ended with the
// scan reporting 0 projects and the daemon booting anyway. Nothing is written
// and nothing is remembered: scanDeclined is untouched, so the same folders
// are offered again next time.

// The scan child's exit code for a q/Esc back-out, distinct from Ctrl-C's 130
// so the entrypoint can tell "not now" (exit 0, message already printed) from
// an abort.
export const CANCEL_EXIT = 131;

export function makeState(items) {
  return {
    items: items.map((i) => ({ ...i, selected: i.selected !== false })),
    cursor: 0,
    top: 0,
  };
}

// Where the window starts. It moves only when the cursor gets within two rows
// of an edge, the way less and fzf scroll: the list holds still while you move
// through the middle of it, and you always see what is coming. A wrap lands on
// the first or last window because the clamp does the rest.
export function scrollTop(top, cursor, n, max) {
  if (n <= max) return 0;
  const off = Math.min(2, Math.floor((max - 1) / 2));
  let t = top;
  if (cursor < t + off) t = cursor - off;
  if (cursor > t + max - 1 - off) t = cursor - max + 1 + off;
  return Math.min(Math.max(0, t), n - max);
}

// Raw stdin bytes to one action, or null for anything we don't handle. A bare
// escape cancels; arrow keys arrive as whole \x1b[A / \x1b[B chunks in raw
// mode, so they never collide with it.
export function decodeKey(buf) {
  const s = buf.toString('utf8');
  if (s === '\x03') return 'abort';
  if (s === '\x1b[A' || s === 'k') return 'up';
  if (s === '\x1b[B' || s === 'j') return 'down';
  if (s === ' ') return 'toggle';
  if (s === 'a' || s === 'A') return 'all';
  if (s === '\r' || s === '\n') return 'confirm';
  if (s === 'q' || s === '\x1b') return 'cancel';
  return null;
}

// One action against one state, immutably. Returns { state, done? } where
// done is 'confirm' or 'cancel' once the interaction is over.
export function reduceKey(state, action) {
  const { items, cursor } = state;
  const n = items.length;
  switch (action) {
    case 'up':
      return { state: { ...state, cursor: (cursor + n - 1) % n } };
    case 'down':
      return { state: { ...state, cursor: (cursor + 1) % n } };
    case 'toggle':
      return {
        state: {
          ...state,
          items: items.map((it, i) => (i === cursor ? { ...it, selected: !it.selected } : it)),
        },
      };
    case 'all': {
      // Everything on unless everything already is; then everything off.
      const target = !items.every((it) => it.selected);
      return { state: { ...state, items: items.map((it) => ({ ...it, selected: target })) } };
    }
    case 'confirm':
      return { state, done: 'confirm' };
    case 'cancel':
      return { state, done: 'cancel' };
    default:
      return { state };
  }
}

// State to display lines. A long list shows a window of it, and says where the
// window is on ONE line under the rows, present for the whole interaction, so
// the frame never changes height and no row moves unless the list scrolled.
// Hints are truncated to the terminal width BEFORE styling, so ANSI codes
// never count against the column budget.
export function renderLines(state, { styler, maxVisible = 12, width = 80, revealed = Infinity } = {}) {
  const { items, cursor } = state;
  const n = items.length;
  const max = Math.max(3, maxVisible);
  const start = scrollTop(state.top || 0, cursor, n, max);
  const end = Math.min(n, start + max);
  // Labels pad to a shared width so the hints form a column; one runaway name
  // does not get to push every path off the right edge.
  const labelWidth = Math.min(24, Math.max(0, ...items.map((it) => it.label.length)));
  const lines = [];
  for (let i = start; i < end; i += 1) {
    // The entrance: rows past `revealed` hold their line blank, so the frame
    // is its final height from the first draw and nothing below it jumps.
    if (i - start >= revealed) { lines.push(''); continue; }
    const it = items[i];
    const cur = i === cursor;
    const box = it.selected ? '◉' : '◯';
    // A chip arrives pre-styled with its plain width alongside, because ANSI
    // codes must never count against the column budget.
    const chip = it.chip ? it.chip.text + ' ' : '';
    const chipCols = it.chip ? it.chip.width + 1 : 0;
    let hint = it.hint || '';
    const label = hint ? it.label.padEnd(labelWidth) : it.label;
    const head = `  ${cur ? '❯' : ' '} ${box} ${label}`;
    const room = width - head.length - chipCols - 3;
    if (hint && hint.length > room) hint = room > 1 ? hint.slice(0, room - 1) + '…' : '';
    lines.push(
      `  ${cur ? styler.cyan('❯') : ' '} ${it.selected ? styler.cyan(box) : styler.dim(box)} ${chip}` +
      `${cur ? styler.bold(label) : label}${hint ? '  ' + styler.dim(hint) : ''}`
    );
  }
  if (n > max) lines.push(styler.dim(`    ${start > 0 ? '↑' : ' '}${end < n ? '↓' : ' '} ${start + 1}–${end} of ${n}`));
  return lines;
}

// The IO shell: draw, read keys, resolve with the outcome, leave the terminal
// exactly as found (raw mode restored, cursor back, picker lines erased).
// A non-TTY caller gets everything selected without a prompt — the picker
// must never block a pipe.
//
// It resolves only on confirm; q/Esc and Ctrl-C exit the process (see the
// header), so a caller never has to decide what "the user said no" means.
export function runPicker({
  items,
  styler,
  heading = '',
  notes = [],
  stdin = process.stdin,
  stdout = process.stdout,
  maxVisible = 12,
  revealMs = 35,
}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve({ cancelled: false, selected: items.map(() => true) });
  }
  return new Promise((resolve) => {
    let state = makeState(items);
    let drawn = 0;
    // The entrance: rows arrive one at a time, revealMs apart, so a scan that
    // took half a second still gets to show what it found. Capped by the
    // window, so it never runs past ~half a second, and any key ends it.
    let revealed = revealMs > 0 ? 0 : Infinity;
    let revealTimer = null;
    const width = stdout.columns || 80;
    const frame = () => {
      const out = [];
      if (heading) out.push(heading);
      out.push(...renderLines(state, { styler, maxVisible, width, revealed }));
      out.push(...notes);
      return out;
    };
    const draw = () => {
      if (drawn) stdout.write(`\x1b[${drawn}A`);
      const out = frame();
      for (const line of out) stdout.write(`\x1b[2K${line}\n`);
      // A shrinking frame (a "more" marker disappearing) must not leave its
      // old last lines behind.
      stdout.write('\x1b[0J');
      drawn = out.length;
    };
    const wasRaw = stdin.isRaw === true;
    const endReveal = () => {
      if (revealTimer) clearInterval(revealTimer);
      revealTimer = null;
      revealed = Infinity;
    };
    const cleanup = () => {
      endReveal();
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\x1b[?25h');
    };
    const erase = () => {
      if (drawn) stdout.write(`\x1b[${drawn}A\x1b[0J`);
      drawn = 0;
    };
    const onData = (buf) => {
      const action = decodeKey(buf);
      if (!action) return;
      endReveal();
      if (action === 'abort') {
        cleanup();
        erase();
        process.exit(130);
      }
      const r = reduceKey(state, action);
      state = { ...r.state, top: scrollTop(r.state.top || 0, r.state.cursor, r.state.items.length, Math.max(3, maxVisible)) };
      if (r.done === 'cancel') {
        cleanup();
        erase();
        stdout.write('  ok, nothing registered. run `wakeman` again whenever.\n');
        process.exit(CANCEL_EXIT);
      }
      if (r.done) {
        cleanup();
        erase();
        resolve({ cancelled: false, selected: state.items.map((i) => i.selected) });
        return;
      }
      draw();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.write('\x1b[?25l');
    draw();
    if (revealed !== Infinity) {
      const rows = Math.min(items.length, Math.max(3, maxVisible));
      revealTimer = setInterval(() => {
        revealed += 1;
        if (revealed >= rows) endReveal();
        draw();
      }, revealMs);
    }
  });
}
