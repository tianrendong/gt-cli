import {
  spawn,
  SpawnOptions,
  spawnSync,
  SpawnSyncOptions,
} from 'child_process';
import { cuteString } from '../utils/cute_string';
import { tracer } from '../utils/tracer';

export function runGitCommandAndSplitLines(
  params: TRunGitCommandParameters
): string[] {
  return runGitCommand(params)
    .split('\n')
    .filter((l) => l.length > 0);
}

export async function runAsyncGitCommandAndSplitLines(
  params: TRunGitCommandParameters
): Promise<string[]> {
  const output = await runAsyncGitCommand(params);
  return output.split('\n').filter((l) => l.length > 0);
}

export type TRunGitCommandParameters = {
  args: string[];
  options?: Omit<SpawnSyncOptions, 'encoding' | 'maxBuffer'> & {
    noTrim?: boolean;
  };
  onError: 'throw' | 'ignore';
  resource: string | null;
};

export function runGitCommand(params: TRunGitCommandParameters): string {
  // Only measure if we're with an existing span.
  return params.resource && tracer.currentSpanId
    ? tracer.spanSync(
        {
          name: 'spawnedCommand',
          resource: params.resource,
          meta: { runCommandArgs: cuteString(params) },
        },
        () => {
          return runGitCommandInternal(params);
        }
      )
    : runGitCommandInternal(params);
}

/** Best-effort bounded binary reads. Callers must retain their normal Git
 * fallback when this returns undefined. Trace the real subprocess without
 * decoding byte-framed output.
 */
export function runGitReadBatch(params: {
  args: string[];
  input: string;
  maxBuffer: number;
  resource: string;
}): Buffer | undefined {
  let output: Buffer | undefined;
  const read = (): Record<string, string> => {
    const result = spawnSync('git', params.args, {
      input: Buffer.from(params.input, 'utf8'),
      encoding: 'buffer',
      maxBuffer: params.maxBuffer,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) output = result.stdout;
    return {
      exitCode: String(result.status),
      signal: result.signal ?? '',
      syscallError: result.error?.message ?? '',
      bytes: String(result.stdout?.length ?? 0),
    };
  };
  if (tracer.currentSpanId)
    tracer.spanSync(
      {
        name: 'spawnedCommand',
        resource: params.resource,
        meta: { runCommandArgs: cuteString({ args: params.args }) },
      },
      read
    );
  else read();
  return output;
}

export type TRunAsyncGitCommandParameters = {
  args: string[];
  options?: SpawnOptions & {
    noTrim?: boolean;
  };
  onError: 'throw' | 'ignore';
  resource: string | null;
};

export function runAsyncGitCommand(
  params: TRunAsyncGitCommandParameters
): Promise<string> {
  // Only measure if we're with an existing span. Several may run at once
  // (e.g. sync's divergence counts), so each is a leaf of the caller's span.
  return params.resource && tracer.currentSpanId
    ? tracer.leafSpan(
        {
          name: 'spawnedCommand',
          resource: params.resource,
          meta: { runCommandArgs: cuteString(params) },
        },
        () => {
          return runAsyncGitCommandInternal(params);
        }
      )
    : runAsyncGitCommandInternal(params);
}

function runGitCommandInternal(params: TRunGitCommandParameters): string {
  const spawnSyncOutput = spawnSync('git', params.args, {
    ...params.options,
    encoding: 'utf-8',
    // 1MB should be enough to never have to worry about this
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });

  // this is a syscall failure, not a command failure
  if (spawnSyncOutput.error) {
    throw spawnSyncOutput.error;
  }

  // if killed with a signal
  if (spawnSyncOutput.signal) {
    throw new CommandKilledError({
      command: 'git',
      args: params.args,
      signal: spawnSyncOutput.signal,
      stdout: spawnSyncOutput.stdout,
      stderr: spawnSyncOutput.stderr,
    });
  }

  // command succeeded, return output
  if (!spawnSyncOutput.status) {
    return (
      (params.options?.noTrim
        ? spawnSyncOutput.stdout
        : spawnSyncOutput.stdout?.trim()) || ''
    );
  }

  // command failed but we ignore it
  if (params.onError === 'ignore') {
    return '';
  }

  throw new CommandFailedError({
    command: 'git',
    args: params.args,
    status: spawnSyncOutput.status,
    stdout: spawnSyncOutput.stdout,
    stderr: spawnSyncOutput.stderr,
  });
}

function runAsyncGitCommandInternal(
  params: TRunAsyncGitCommandParameters
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', params.args, {
      ...params.options,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // e.g. spawn failures (EAGAIN, EMFILE): reject rather than crash on an
    // unhandled 'error' event or leave the promise pending.
    proc.on('error', reject);

    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', function (data) {
      stdout += data.toString();
    });

    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', function (data) {
      stderr += data.toString();
    });

    proc.addListener('close', (code, signal) => {
      if (signal) {
        reject(
          new CommandKilledError({
            command: 'git',
            args: params.args,
            signal: signal,
            stdout: stdout,
            stderr: stderr,
          })
        );
      }

      if (code === 0) {
        resolve(params.options?.noTrim ? stdout : stdout.trim());
      }

      if (params.onError === 'ignore') {
        resolve('');
      }

      reject(
        new CommandFailedError({
          command: 'git',
          args: params.args,
          status: code || 1,
          stdout,
          stderr,
        })
      );
    });
  });
}

export class CommandFailedError extends Error {
  readonly status: number;

  constructor(failure: {
    command: string;
    args: string[];
    status: number;
    errno?: number;
    code?: string;
    stdout: string;
    stderr: string;
  }) {
    super(
      [
        failure.errno && failure.code
          ? `Command failed with error ${failure.code} (${failure.errno}), exit code ${failure.status}:`
          : `Command failed with error exit code ${failure.status}:`,
        [failure.command].concat(failure.args).join(' '),
        failure.stdout,
        failure.stderr,
      ].join('\n')
    );
    this.name = 'CommandFailed';
    this.status = failure.status;
  }
}

export class CommandKilledError extends Error {
  readonly signal: string;

  constructor(failure: {
    command: string;
    args: string[];
    signal: string;
    stdout: string;
    stderr: string;
  }) {
    super(
      [
        `Command killed with signal ${failure.signal}:`,
        [failure.command].concat(failure.args).join(' '),
        failure.stdout,
        failure.stderr,
      ].join('\n')
    );
    this.name = 'CommandKilled';
    this.signal = failure.signal;
  }
}
