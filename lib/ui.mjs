// Terminal styling for the CLI banner — zero deps, and silent degradation.
//
// ANSI styles apply only when stdout is an interactive terminal, NO_COLOR is
// unset/empty (https://no-color.org: a non-empty value disables color), and
// TERM is not "dumb". Piped output gets the plain text, so `wakeman | pbcopy`
// never captures escape codes.
//
// Cyan is the accent (the tool name, URLs), bold marks the things worth
// copying, dim is everything explanatory. The consent screen gives each action
// its own colored verb so four lines of prose read as four separate things.
// Red is reserved for errors.

// The first-run logo: figlet's standard font, hard-coded so there is still no
// dependency, with the z's drifting off the tail because sleeping servers are
// the whole product. Only the consent prompt prints it; re-runs stay terse.
export const LOGO = [
  "                  _                                        Z",
  "__      __  __ _ | | __  ___  _ __ ___    __ _  _ __     z",
  "\\ \\ /\\ / / / _` || |/ / / _ \\| '_ ` _ \\  / _` || '_ \\  z",
  " \\ V  V / | (_| ||   < |  __/| | | | | || (_| || | | |",
  "  \\_/\\_/   \\__,_||_|\\_\\ \\___||_| |_| |_| \\__,_||_| |_|",
];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// A one-line spinner for the phases of a run (scan, install, daemon wake-up).
// Interactive terminals get braille frames redrawn in place, and each phase
// stays on screen for at least minMs so a fast machine still shows its work
// instead of flashing. Pipes and dumb terminals get none of it — no frames,
// no delays — so CI logs stay clean and fast; only the final line prints.
export function makeSpinner({ isTTY, styler, minMs = 450, intervalMs = 80, stream = process.stdout } = {}) {
  const live = Boolean(isTTY);
  let timer = null;
  let frame = 0;
  let text = '';
  let startedAt = 0;
  const draw = () => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    stream.write(`\r\x1b[2K  ${styler.cyan(SPINNER_FRAMES[frame])} ${styler.dim(text)}`);
  };
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (live) stream.write('\r\x1b[2K');
  };
  return {
    start(t) {
      text = t;
      startedAt = Date.now();
      if (!live) return;
      draw();
      timer = setInterval(draw, intervalMs);
    },
    update(t) {
      text = t;
    },
    // Phase over: hold until minMs is up, wipe the spinner line, and leave the
    // result line (already styled by the caller) in its place.
    async done(finalLine) {
      if (live) {
        const left = minMs - (Date.now() - startedAt);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
      }
      clear();
      if (finalLine) stream.write(`  ${finalLine}\n`);
    },
    // Phase failed: wipe immediately, no minimum hold. The caller prints the
    // error to stderr.
    fail() {
      clear();
    },
  };
}

// Lay short strings out in columns, reading DOWN each column like `ls`, so an
// alphabetical list stays alphabetical to the eye. Widths come from the plain
// text and `paint` styles a cell after it is measured, so ANSI codes never
// count against the column budget. A terminal too narrow for two columns gets
// one; a list past maxRows is cut and the caller is told how many are hidden.
export function columnize(cells, { width = 80, indent = 2, gap = 4, maxCols = 2, maxRows = 20, paint = (s) => s } = {}) {
  if (!cells.length) return { lines: [], hidden: 0 };
  const cellWidth = Math.max(...cells.map((c) => c.length));
  const fit = Math.floor((width - indent + gap) / (cellWidth + gap));
  const cols = Math.max(1, Math.min(maxCols, fit, cells.length));
  const shown = cells.slice(0, cols * maxRows);
  const rows = Math.ceil(shown.length / cols);
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    const parts = [];
    for (let c = 0; c < cols; c += 1) {
      const cell = shown[c * rows + r];
      if (cell === undefined) continue;
      const last = c === cols - 1 || shown[(c + 1) * rows + r] === undefined;
      parts.push(paint(cell) + (last ? '' : ' '.repeat(cellWidth - cell.length + gap)));
    }
    lines.push(' '.repeat(indent) + parts.join(''));
  }
  return { lines, hidden: cells.length - shown.length };
}

export function makeStyler({ isTTY, env = {} } = {}) {
  const enabled =
    Boolean(isTTY) &&
    !(typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') &&
    env.TERM !== 'dumb';
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  // 24-bit color where the terminal says it has it, the 6x6x6 cube otherwise:
  // Terminal.app before macOS 26 drops truecolor sequences on the floor, and
  // every terminal that does color at all does the cube.
  const truecolor = /^(truecolor|24bit)$/.test(env.COLORTERM || '');
  const cube = ([r, g, b]) => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
  const sgr = (layer, rgb) => (truecolor ? `${layer};2;${rgb.join(';')}` : `${layer};5;${cube(rgb)}`);
  return {
    enabled,
    // A filled pill: `text` on a `bg` background. Plain text when styling is off.
    pill: (text, bg, fg) => (enabled ? `\x1b[${sgr(48, bg)};${sgr(38, fg)}m${text}\x1b[39;49m` : String(text)),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    magenta: wrap(35, 39),
    red: wrap(31, 39),
    // Foreground in an exact color, for the one place a gradient earns it (the logo).
    rgb: (text, color) => (enabled ? `\x1b[${sgr(38, color)}m${text}\x1b[39m` : String(text)),
  };
}

// Framework chips, the terminal twin of the dashboard's frameworkIcon: same
// brand colors, so a project wears one color everywhere wakeman shows it. Next is
// inverted (white pill) because its black brand mark vanishes on a dark
// terminal. Unknown frameworks get the static gray.
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const FRAMEWORK_COLORS = {
  next: [WHITE, BLACK],
  vite: [[100, 108, 255], WHITE],
  cra: [[35, 39, 47], [97, 218, 251]],
  astro: [[124, 58, 237], WHITE],
  remix: [[57, 146, 255], WHITE],
  sveltekit: [[255, 62, 0], WHITE],
  rails: [[204, 0, 0], WHITE],
  django: [[9, 46, 32], [68, 183, 139]],
  node: [[95, 160, 78], WHITE],
  static: [[100, 116, 139], WHITE],
};

// One chip. `width` is the plain-text width of the widest chip in the list, so
// the caller's next column lines up; the padding sits OUTSIDE the pill, which
// keeps every pill hugging its own word.
export function frameworkChip(framework, styler, width = 0) {
  const name = String(framework || '?');
  const [bg, fg] = FRAMEWORK_COLORS[name] || FRAMEWORK_COLORS.static;
  const text = ` ${name} `;
  return styler.pill(text, bg, fg) + ' '.repeat(Math.max(0, width - text.length));
}
export const chipWidth = (frameworks) => Math.max(0, ...frameworks.map((f) => String(f || '?').length + 2));

// "20 next · 7 vite · 1 static", biggest group first: what the scan turned up,
// in one line, as chips.
export function frameworkTally(frameworks, styler) {
  const counts = new Map();
  for (const f of frameworks) counts.set(f || '?', (counts.get(f || '?') || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([f, n]) => (styler.enabled ? `${n} ${frameworkChip(f, styler)}` : `${n} ${f}`))
    .join(styler.enabled ? '  ' : ' · ');
}

// The logo fades cyan to violet, top line to bottom.
export function paintLogo(styler) {
  const from = [34, 211, 238];
  const to = [167, 139, 250];
  return LOGO.map((line, i) => {
    const t = i / (LOGO.length - 1);
    return styler.rgb(line, from.map((c, k) => Math.round(c + (to[k] - c) * t)));
  });
}
