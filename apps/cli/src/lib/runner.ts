import yargs from 'yargs';
import chalk from 'chalk';
import { version } from '../../package.json';
import {
  repositoryInitialized,
  INITIALIZATION_REQUIRED,
} from './switch/initialization';
import { StackStore } from './github/stack_file';
import { exportLocalStacks, importLocalStacks } from './github/local_stacks';
import {
  assertNoRollbackInProgress,
  beginOperation,
  finishOperation,
  latestOperation,
  Operation,
  recordOperationWorktreeMoves,
} from './operations/journal';
import {
  initContext,
  initContextLite,
  TContext,
  TContextLite,
} from './context';
import { getCacheLock, TCacheLock } from './engine/cache_lock';
import {
  BadTrunkOperationError,
  ConcurrentExecutionError,
  DetachedError,
  ExitFailedError,
  KilledError,
  PreconditionsFailedError,
  RebaseConflictError,
  UntrackedBranchError,
} from './errors';
import { composeGit } from './git/git';
import { TGlobalArguments } from './global_arguments';
import { tracer } from './utils/tracer';
import { CommandFailedError, CommandKilledError } from './git/runner';
import { Repository } from './switch/repository';
import {
  assertCandidateEnabled,
  recordCandidateConfig,
  SwitchState,
} from './switch/state';

/** Commands that only inspect the repository. They never wait for this
 * worktree's stack lock (commands in other worktrees never contend at all).
 * If the lock is free and no operation is pending, they reconcile the gh-stack
 * mirror, then release it before running so pagers, prompts, and remote reads
 * cannot stall commands in other terminals. A busy lock or pending recovery
 * means reading the repository as it is, without changing stack metadata;
 * the mutating command publishes the mirror when it finishes.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'log',
  'log short',
  'log long',
  'info',
  'branch info',
  'parent',
  'children',
  'trunk',
  'state',
  'pr',
  'github status',
  'internal-only cat',
  'internal-only changed-files',
  'internal-only config',
  'internal-only diff',
  'internal-only log',
  'internal-only relative-cat',
  'internal-only repo-info',
  'internal-only root',
  'internal-only status',
  'internal-only templates',
]);

export async function graphite(
  args: yargs.Arguments & TGlobalArguments,
  canonicalName: string,
  handler: (context: TContext) => Promise<void>
): Promise<void> {
  return graphiteInternal(args, canonicalName, {
    repo: true as const,
    run: handler,
  });
}

export async function graphiteWithoutRepo(
  args: yargs.Arguments & TGlobalArguments,
  canonicalName: string,
  handler: (context: TContextLite) => Promise<void>
): Promise<void> {
  return graphiteInternal(args, canonicalName, {
    repo: false as const,
    run: handler,
  });
}

function recoveryBlocksReconciliation(): boolean {
  try {
    const operation = latestOperation({ readOnly: true });
    return Boolean(
      operation?.pending ||
        operation?.restoringRefs ||
        operation?.abortingRebase
    );
  } catch {
    // Unknown or damaged journals must block mutations, not diagnostic reads.
    // Without a known checkpoint, don't reconcile or repair stack metadata.
    return true;
  }
}

async function graphiteInternal(
  args: yargs.Arguments & TGlobalArguments,
  canonicalName: string,
  handler: TGraphiteCommandHandler
): Promise<void> {
  const handlerMaybeWithCacheLock = handler.repo
    ? {
        ...handler,
        cacheLock: getCacheLock(),
      }
    : { ...handler, cacheLock: undefined };

  process.on('SIGINT', (): never => {
    handlerMaybeWithCacheLock.cacheLock?.release();
    // End all current traces abruptly.
    tracer.allSpans.forEach((s) => s.end(undefined, new KilledError()));
    // eslint-disable-next-line no-restricted-syntax
    process.exit(1);
  });
  let stackStore: StackStore | undefined;
  let switchRepo: Repository | undefined;
  let switchState: SwitchState | undefined;
  const readOnly = READ_ONLY_COMMANDS.has(canonicalName);
  const git = composeGit();
  const contextLite = initContextLite({
    ...args,
    userEmail: git.getUserEmail(),
  });

  try {
    await tracer.span(
      {
        name: 'command',
        resource: canonicalName,
        meta: {
          user: contextLite.userEmail ?? 'NotFound',
          version: version,
          gtInteractive: process.env.GRAPHITE_INTERACTIVE ? 'true' : 'false',
          processArgv:
            canonicalName === 'auth'
              ? 'gt auth [redacted]'
              : process.argv.join(' '),
        },
      },
      async () => {
        if (!handlerMaybeWithCacheLock.repo) {
          await handlerMaybeWithCacheLock.run(contextLite);
          return;
        }

        const repo = new Repository(process.cwd());
        if (
          !['init', 'repo init'].includes(canonicalName) &&
          !repositoryInitialized(repo)
        )
          throw new ExitFailedError(INITIALIZATION_REQUIRED);
        stackStore = readOnly ? StackStore.tryOpen() : await StackStore.open();
        if (readOnly && stackStore && recoveryBlocksReconciliation()) {
          // Mirror exports and parser repairs would invalidate the journal's
          // checkpoint. Use the existing lock-free, non-reconciling read path
          // until continue/abort (or an interrupted undo) finishes recovery.
          stackStore.close();
          stackStore = undefined;
        }
        switchRepo = repo;
        switchState = assertCandidateEnabled(switchRepo);
        const context = initContext(contextLite, git, {
          ...args,
          readOnly: readOnly && !stackStore,
        });
        context.githubStacks = stackStore;
        return await graphiteHelper(
          canonicalName,
          handlerMaybeWithCacheLock,
          context,
          Boolean(args['dry-run']),
          readOnly
        );
      }
    );
  } catch (err) {
    handleGraphiteError(err, contextLite);
    contextLite.splog.debug(err.stack);
    // print errors when debugging tests
    if (process.env.DEBUG) {
      process.stdout.write(err.stack.toString());
    }
    process.exitCode = 1;
  } finally {
    finalizeCommand({
      contextLite,
      readOnly,
      stackStore,
      switchRepo,
      switchState,
    });
  }
}

/** Persist the switch configuration, then release the mirror. */
function finalizeCommand(state: {
  contextLite: TContextLite;
  readOnly: boolean;
  stackStore?: StackStore;
  switchRepo?: Repository;
  switchState?: SwitchState;
}): void {
  try {
    // Read-only commands change no configuration, and may no longer hold the lock.
    if (state.switchRepo && !state.readOnly)
      recordCandidateConfig(state.switchRepo, state.switchState);
  } catch (error) {
    handleGraphiteError(error, state.contextLite);
    process.exitCode = 1;
  } finally {
    state.stackStore?.close();
  }
}

// eslint-disable-next-line max-params
async function graphiteHelper(
  canonicalName: string,
  handler: TGraphiteCommandHandlerWithCacheLock,
  context: TContext,
  dryRun = false,
  readOnly = false
): Promise<{
  cacheBefore: string;
  cacheAfter: string;
}> {
  const cacheBefore = context.engine.debug;
  let operation: Operation | undefined;
  const store = context.githubStacks;
  // github status shows the mirror without changing it.
  const mirror =
    store && !dryRun && canonicalName !== 'github status' ? store : undefined;
  // A read-only command that acquired the lock persists before releasing it;
  // without the lock, the engine stamps the cache for the refs it parsed.
  const persistLater = !readOnly || !store;
  const persistCache = () => {
    try {
      context.engine.persist();
    } catch (persistError) {
      context.engine.clear();
      context.splog.debug(`Failed to persist Graphite cache`);
    }
  };

  try {
    if (
      !['init', 'repo init'].includes(canonicalName) &&
      !context.repoConfig.graphiteInitialized()
    ) {
      throw new ExitFailedError(INITIALIZATION_REQUIRED);
    }

    if (mirror && canonicalName !== 'github import') {
      importLocalStacks(context, mirror);
    }
    if (readOnly) {
      // Publish the reconciled mirror and cache, then let others proceed while
      // this command prints, pages, or waits on GitHub.
      if (mirror) exportLocalStacks(context, mirror);
      if (store) {
        persistCache();
        store.close();
      }
    } else if (canonicalName === 'continue') {
      const pending = latestOperation();
      assertNoRollbackInProgress(pending);
      if (
        pending?.pending &&
        context.engine.rebaseInProgress() &&
        context.continueConfig.data.rebasedBranchBase
      ) {
        operation = pending;
        recordOperationWorktreeMoves(operation);
      }
    } else {
      operation = beginOperation(canonicalName, dryRun);
    }
    await handler.run(context);
    if (mirror && !readOnly) exportLocalStacks(context, mirror);
  } catch (err) {
    if (
      err.constructor === DetachedError &&
      context.engine.rebaseInProgress()
    ) {
      throw new DetachedError(
        `Did you mean to run ${chalk.cyan(`gt continue`)}?`
      );
    }
    throw err;
  } finally {
    if (persistLater) persistCache();
    try {
      finishOperation(operation, context.engine.rebaseInProgress());
    } finally {
      handler.cacheLock.release();
    }
  }

  return { cacheBefore, cacheAfter: context.engine.debug };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleGraphiteError(err: any, context: TContextLite): void {
  switch (err.constructor) {
    case CommandKilledError:
    case KilledError: // the user doesn't need a message if they ended gt
    case RebaseConflictError: // we've already logged a message
      // pass
      return;

    case UntrackedBranchError:
    case BadTrunkOperationError:
    case ExitFailedError:
    case ConcurrentExecutionError:
    case PreconditionsFailedError:
    case CommandFailedError:
    default:
      context.splog.error(err.message);
      return;
  }
}

// typescript is fun!
type TGraphiteCommandHandler =
  | { repo: true; run: (context: TContext) => Promise<void> }
  | {
      repo: false;
      run: (contextLite: TContextLite) => Promise<void>;
    };
type TGraphiteCommandHandlerWithCacheLock = {
  run: (context: TContext) => Promise<void>;
  cacheLock: TCacheLock;
};
