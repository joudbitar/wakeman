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
  };
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
      return { state: { items, cursor: (cursor + n - 1) % n } };
    case 'down':
      return { state: { items, cursor: (cursor + 1) % n } };
    case 'toggle':
      return {
        state: {
          cursor,
          items: items.map((it, i) => (i === cursor ? { ...it, selected: !it.selected } : it)),
        },
      };
    case 'all': {
      // Everything on unless everything already is; then everything off.
      const target = !items.every((it) => it.selected);
      return { state: { cursor, items: items.map((it) => ({ ...it, selected: target })) } };
    }
    case 'confirm':
      return { state, done: 'confirm' };
    case 'cancel':
      return { state, done: 'cancel' };
    default:
      return { state };
  }
}

// State to display lines. Long lists get a window around the cursor with
// dim "N more" markers; hints are truncated to the terminal width BEFORE
// styling, so ANSI codes never count against the column budget.
export function renderLines(state, { styler, maxVisible = 12, width = 80 } = {}) {
  const { items, cursor } = state;
  const n = items.length;
  const max = Math.max(3, maxVisible);
  let start = 0;
  if (n > max) start = Math.min(Math.max(0, cursor - Math.floor(max / 2)), n - max);
  const end = Math.min(n, start + max);
  const lines = [];
  if (start > 0) lines.push(styler.dim(`    ↑ ${start} more`));
  for (let i = start; i < end; i += 1) {
    const it = items[i];
    const cur = i === cursor;
    const box = it.selected ? '◉' : '◯';
    const head = `  ${cur ? '❯' : ' '} ${box} ${it.label}`;
    let hint = it.hint || '';
    const room = width - head.length - 3;
    if (hint && hint.length > room) hint = room > 1 ? hint.slice(0, room - 1) + '…' : '';
    lines.push(
      `  ${cur ? styler.cyan('❯') : ' '} ${it.selected ? styler.cyan(box) : styler.dim(box)} ` +
      `${cur ? styler.bold(it.label) : it.label}${hint ? '  ' + styler.dim(hint) : ''}`
    );
  }
  if (end < n) lines.push(styler.dim(`    ↓ ${n - end} more`));
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
}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve({ cancelled: false, selected: items.map(() => true) });
  }
  return new Promise((resolve) => {
    let state = makeState(items);
    let drawn = 0;
    const width = stdout.columns || 80;
    const frame = () => {
      const out = [];
      if (heading) out.push(heading);
      out.push(...renderLines(state, { styler, maxVisible, width }));
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
    const cleanup = () => {
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
      if (action === 'abort') {
        cleanup();
        erase();
        process.exit(130);
      }
      const r = reduceKey(state, action);
      state = r.state;
      if (r.done === 'cancel') {
        cleanup();
        erase();
        stdout.write('  ok, nothing registered. run `lazydev` again whenever.\n');
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
  });
}
