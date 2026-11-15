// Management output only: do not change gt's native-compatible presentation.
// No package dependencies: the installer also uses this before installing them.
const tty = require('tty');
const styles = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
};

/** @param {'stdout' | 'stderr'} stream */
function enabled(stream) {
  // Explicit opt-outs win, including an empty NO_COLOR.
  if (
    process.env.NO_COLOR !== undefined ||
    process.env.NODE_DISABLE_COLORS !== undefined
  )
    return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return ['', 'true', '1', '2', '3'].includes(force);
  return process.env.TERM !== 'dumb' && tty.isatty(stream === 'stderr' ? 2 : 1);
}

/**
 * @param {'stdout' | 'stderr'} stream
 * @param {keyof typeof styles} style
 * @param {string} text
 */
function color(stream, style, text) {
  if (!enabled(stream)) return text;
  const [open, close] = styles[style];
  const start = `\u001b[${open}m`,
    end = `\u001b[${close}m`;
  return text
    .split('\n')
    .map((line) => (line ? start + line.split(end).join(start) + end : line))
    .join('\n');
}

/** @param {string} text */
function help(text) {
  return text
    .split('\n')
    .map((line) =>
      /^\s*(?:gt-cli|install\.sh|enable\.sh|disable\.sh)\b/.test(line)
        ? color('stdout', 'cyan', line)
        : line.replace(/\B--[a-z][a-z-]*/g, (flag) =>
            color('stdout', 'cyan', flag)
          )
    )
    .join('\n');
}

/**
 * Keep error details and recovery instructions legible, not a wall of color.
 * @param {'stdout' | 'stderr'} stream
 * @param {'red' | 'yellow'} style
 * @param {string} text
 */
function diagnostic(stream, style, text) {
  const [heading, ...details] = text.split('\n');
  return [color(stream, style, heading), ...details].join('\n');
}

module.exports = { color, help, diagnostic };
