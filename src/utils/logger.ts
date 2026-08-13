/**
 * Minimal terminal output helpers.
 *
 * No logging library. We need colour, a progress line, and a few formatted
 * lines - about 80 lines of code. Pulling in chalk/ora/cli-table would add
 * dependencies and supply-chain surface for something this small.
 */

/** Colour is disabled when output is piped to a file or NO_COLOR is set. */
const useColour =
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

/**
 * ANSI colour sequences begin with the ESC control character (0x1B).
 *
 * We build it with String.fromCharCode rather than pasting a literal escape
 * byte into the source. A raw control character is invisible in editors and
 * gets silently stripped by copy/paste and some tooling - this form is
 * explicit and survives everything.
 */
const ESC = String.fromCharCode(27);

function paint(code: string, text: string): string {
  return useColour ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

export const colour = {
  bold: (t: string): string => paint('1', t),
  dim: (t: string): string => paint('2', t),
  red: (t: string): string => paint('31', t),
  green: (t: string): string => paint('32', t),
  yellow: (t: string): string => paint('33', t),
  blue: (t: string): string => paint('34', t),
  cyan: (t: string): string => paint('36', t),
};

export function heading(text: string): void {
  console.log('');
  console.log(colour.bold(text));
  console.log(colour.dim('-'.repeat(text.length)));
}

/** Left-aligned "label   value" line, for summary blocks. */
export function field(label: string, value: string | number, width = 28): void {
  console.log(`  ${label.padEnd(width)} ${colour.bold(String(value))}`);
}

export function warn(text: string): void {
  console.log(`  ${colour.yellow('!')} ${text}`);
}

export function info(text: string): void {
  console.log(`  ${text}`);
}

/**
 * A single-line progress indicator that rewrites itself.
 *
 * Only used on a TTY. When output is redirected to a file, rewriting the
 * line with a carriage return would produce an unreadable mess, so we stay
 * silent instead.
 */
export function progressLine(done: number, total: number, label: string): void {
  if (!process.stdout.isTTY) return;
  const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
  const text = `  ${label} ${done}/${total} (${pct}%)`;
  process.stdout.write('\r' + text.padEnd(64));
}

export function clearProgressLine(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\r' + ' '.repeat(64) + '\r');
}

/** Thousands separators, so 2985 reads as "2,985". */
export function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** Bytes as a human-readable size. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Milliseconds as a human-readable duration. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
