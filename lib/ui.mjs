// Terminal styling for the CLI banner — zero deps, and silent degradation.
//
// ANSI styles apply only when stdout is an interactive terminal, NO_COLOR is
// unset/empty (https://no-color.org: a non-empty value disables color), and
// TERM is not "dumb". Piped output gets the plain text, so `xerb | pbcopy`
// never captures escape codes.
//
// One accent color (cyan) for the tool name, bold for the things worth
// copying (URLs), dim for everything explanatory. Red is reserved for errors.

// The first-run logo: figlet's standard font, hard-coded so there is still no
// dependency, with the z's drifting off the tail because sleeping servers are
// the whole product. Only the consent prompt prints it; re-runs stay terse.
export const LOGO = [
  "               _          Z",
  "__  _____ _ __| |__     z",
  "\\ \\/ / _ \\ '__| '_ \\  z",
  " >  <  __/ |  | |_) |",
  "/_/\\_\\___|_|  |_.__/",
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

export function makeStyler({ isTTY, env = {} } = {}) {
  const enabled =
    Boolean(isTTY) &&
    !(typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') &&
    env.TERM !== 'dumb';
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    red: wrap(31, 39),
  };
}
