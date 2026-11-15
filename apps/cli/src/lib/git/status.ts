import { TStatusFile } from './changed_files';
import { runGitCommand } from './runner';

// Using pretty formats specified here

export function getStatus(): TStatusFile[] {
  const result = runGitCommand({
    args: [`status`, '-z'],
    onError: 'ignore',
    resource: 'getStatus',
    options: { noTrim: true },
  });

  const files: TStatusFile[] = [];

  const tokens = result.split('\0');
  // Last character is always whitespace as it ends in a NULL terminator
  for (let i = 0; i < tokens.length - 1; i) {
    const rawStatus = tokens[i];

    // https://git-scm.com/docs/git-status#_short_format
    const indexStatus = rawStatus[0];
    const workingTreeStatus = rawStatus[1];
    const path = rawStatus.slice(3);

    const statusAndStaged = statusFromStatusCode(
      indexStatus,
      workingTreeStatus
    );

    // Renamed and copied files include the origin before the destination (but the origin is a new line)
    if (
      statusAndStaged.status === 'copied' ||
      statusAndStaged.status === 'renamed'
    ) {
      files.push({ path, ...statusAndStaged, from: tokens[i + 1] });
      i += 2;
    } else {
      files.push({ path, ...statusAndStaged, from: undefined });
      i += 1;
    }
  }

  return files;
}

function statusFromStatusCode(
  indexStatus: string,
  workingTreeStatus: string
): Pick<TStatusFile, 'status' | 'staged'> {
  if (
    (indexStatus === 'A' && workingTreeStatus === 'A') ||
    (indexStatus === 'D' && workingTreeStatus === 'D') ||
    indexStatus === 'U' ||
    workingTreeStatus === 'U'
  ) {
    return {
      status: 'unresolved' as const,
      staged: 'none',
    };
  }

  if (workingTreeStatus === '?') {
    return {
      status: 'added' as const,
      staged: 'none',
    };
  }

  if (indexStatus === ' ') {
    if (workingTreeStatus === 'M' || workingTreeStatus === 'T') {
      return {
        status: 'modified' as const,
        staged: 'none',
      };
    }

    if (workingTreeStatus === 'D') {
      return {
        status: 'deleted' as const,
        staged: 'none',
      };
    }

    if (workingTreeStatus === 'C') {
      return {
        status: 'copied' as const,
        staged: 'none',
      };
    }

    if (workingTreeStatus === 'R') {
      return {
        status: 'renamed' as const,
        staged: 'none',
      };
    }

    if (workingTreeStatus === 'A') {
      return {
        status: 'added' as const,
        staged: 'none',
      };
    }
  }

  if (indexStatus === 'M' || indexStatus === 'T') {
    return {
      status: 'modified' as const,
      staged: workingTreeStatus === ' ' ? 'full' : 'partial',
    };
  }

  if (indexStatus === 'A') {
    return {
      status: 'added' as const,
      staged: workingTreeStatus === ' ' ? 'full' : 'partial',
    };
  }

  if (indexStatus === 'D') {
    return {
      status: 'deleted' as const,
      staged: workingTreeStatus === ' ' ? 'full' : 'partial',
    };
  }

  if (indexStatus === 'C') {
    return {
      status: 'copied' as const,
      staged: workingTreeStatus === ' ' ? 'full' : 'partial',
    };
  }

  if (indexStatus === 'R') {
    return {
      status: 'renamed' as const,
      staged: workingTreeStatus === ' ' ? 'full' : 'partial',
    };
  }

  return {
    status: 'modified' as const,
    staged: 'none',
  };
}
