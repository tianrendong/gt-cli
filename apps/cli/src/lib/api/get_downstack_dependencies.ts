import { execFileSync } from 'child_process';
import { ExitFailedError } from '../errors';

/**
 * Reconstruct the downstack dependency chain for a branch using GitHub PR
 * base-ref pointers (via the `gh` CLI), since this GitHub-only CLI does not
 * have access to Graphite's proprietary stack API.
 *
 * Walks the chain of PR base branches starting from `branchName` until it
 * reaches `trunkName`. Returns the branches ordered bottom-to-top (closest to
 * trunk first), excluding trunk itself - matching the shape expected by
 * `getBranchesFromRemote`.
 */
export async function getDownstackDependencies(
  args: { branchName: string; trunkName: string },
  _params: unknown,
  _context: unknown
): Promise<string[]> {
  const { branchName, trunkName } = args;

  if (branchName === trunkName) {
    return [];
  }

  const chain: string[] = [];
  const seen = new Set<string>();
  let current = branchName;

  // Guard against cycles / runaway loops in malformed stacks.
  const MAX_DEPTH = 100;

  while (current !== trunkName) {
    if (seen.has(current)) {
      throw new ExitFailedError(
        `Detected a cycle while resolving the stack for ${branchName} at ${current}.`
      );
    }
    if (chain.length >= MAX_DEPTH) {
      throw new ExitFailedError(
        `Stack for ${branchName} is too deep (>${MAX_DEPTH}); aborting.`
      );
    }
    seen.add(current);

    const base = getPrBaseRef(current);
    if (!base) {
      throw new ExitFailedError(
        [
          `Could not find an open pull request for ${current} on the remote.`,
          `\`gt get\` reconstructs a stack from GitHub PR base branches, so each`,
          `branch from ${branchName} down to ${trunkName} must have a PR.`,
        ].join('\n')
      );
    }

    chain.push(current);
    current = base;
  }

  // chain is currently top-to-bottom (branchName ... first-above-trunk);
  // reverse to bottom-to-top for getBranchesFromRemote.
  return chain.reverse();
}

function getPrBaseRef(branchName: string): string | undefined {
  try {
    const output = execFileSync(
      'gh',
      ['pr', 'view', branchName, '--json', 'baseRefName,headRefName,state'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString();
    const pr = JSON.parse(output) as {
      baseRefName?: string;
      headRefName?: string;
      state?: string;
    };
    // Only follow the branch's own PR (headRef must match).
    if (pr.headRefName && pr.headRefName !== branchName) {
      return undefined;
    }
    return pr.baseRefName;
  } catch {
    return undefined;
  }
}
