import { runAsyncGitCommand, runGitCommand } from './runner';

const FORMAT = {
  READABLE: '%h - %s',
  // Unit separator between relative committer date and the READABLE line, so
  // one process serves both fields for a whole range. Consumers split on \x1f.
  READABLE_WITH_DATE: '%cr%x1f%h - %s',
  SUBJECT: '%s',
  MESSAGE: '%B%n',
  COMMITTER_DATE: '%cr',
  SHA: '%H',
} as const;
export type TCommitFormat = keyof typeof FORMAT;

// One process for the whole range: `git log -z` with `--pretty=format:`
// separates commits with NUL, so multi-line messages stay intact and empty
// subjects/messages still produce their (empty) entries. Each entry is trimmed
// exactly as the previous one-process-per-commit implementation trimmed each
// commit's output.
function getCommitRangeArgs(
  base: string | undefined,
  head: string,
  format: TCommitFormat
): string[] {
  return [
    `--no-pager`,
    `log`,
    `-z`,
    // if no base is passed in, just get one commit (e.g. trunk)
    ...(base ? [] : [`-1`]),
    `--pretty=format:${FORMAT[format]}`,
    base ? `${base}..${head}` : head,
  ];
}

function splitCommitRange(base: string | undefined, output: string): string[] {
  return base
    ? output
      ? output.split('\0').map((entry) => entry.trim())
      : []
    : [output.trim()];
}

export function getCommitRange(
  base: string | undefined,
  head: string,
  format: TCommitFormat
): string[] {
  return splitCommitRange(
    base,
    runGitCommand({
      args: getCommitRangeArgs(base, head, format),
      options: { noTrim: true },
      onError: 'throw',
      resource: 'getCommitRangeFormatted',
    })
  );
}

export async function getCommitRangeAsync(
  base: string | undefined,
  head: string,
  format: TCommitFormat
): Promise<string[]> {
  return splitCommitRange(
    base,
    await runAsyncGitCommand({
      args: getCommitRangeArgs(base, head, format),
      options: { noTrim: true },
      onError: 'throw',
      resource: 'getCommitRangeFormatted',
    })
  );
}
