import { runGitCommandAndSplitLines } from './runner';

/** One ref scan for the persisted cache seed; retain each legacy query's order. */
export function getBranchesAndMetadata(
  options: { includeReplacementRefs?: boolean } = {}
): {
  gitBranchNamesAndRevisions: Record<string, string>;
  metadataRefList: Record<string, string>;
  hasReplacementRefs?: boolean;
} {
  const gitBranchNamesAndRevisions: Record<string, string> = {};
  const metadata: Array<[string, string]> = [];
  let hasReplacementRefs = false;
  const lines = runGitCommandAndSplitLines({
    args: [
      'for-each-ref',
      '--format=%(refname)%00%(refname:short)%00%(objectname)',
      '--sort=-committerdate',
      'refs/heads/',
      'refs/branch-metadata/',
      ...(options.includeReplacementRefs ? ['refs/replace/'] : []),
    ],
    onError: 'throw',
    resource: 'getBranchesAndMetadata',
  });
  for (const line of lines) {
    const [ref, short, sha] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      gitBranchNamesAndRevisions[short] = sha;
    } else if (ref.startsWith('refs/branch-metadata/')) {
      metadata.push([ref.slice('refs/branch-metadata/'.length), sha]);
    } else if (ref.startsWith('refs/replace/')) {
      hasReplacementRefs = true;
    }
  }
  metadata.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const metadataRefList: Record<string, string> = {};
  for (const [name, sha] of metadata) metadataRefList[name] = sha;
  return {
    gitBranchNamesAndRevisions,
    metadataRefList,
    ...(options.includeReplacementRefs ? { hasReplacementRefs } : {}),
  };
}

export function getBranchNamesAndRevisions(): Record<string, string> {
  const branches: Record<string, string> = {};

  runGitCommandAndSplitLines({
    args: [
      `for-each-ref`,
      `--format=%(refname:short):%(objectname)`,
      `--sort=-committerdate`,
      `refs/heads/`,
    ],
    onError: 'throw',
    resource: 'getBranchNamesAndRevisions',
  })
    .map((line) => line.split(':'))
    .filter(
      (lineSplit): lineSplit is [string, string] =>
        lineSplit.length === 2 && lineSplit.every((s) => s.length > 0)
    )
    .forEach(([branchName, sha]) => (branches[branchName] = sha));

  return branches;
}
