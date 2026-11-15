export type PRNumber = string;
export type BranchName = string;
export type RepoRelativePath = string;

export type ChangedFileType =
  | `${'TRACKED' | 'PARTIALLY_TRACKED' | 'UNTRACKED'}_${
      | 'ADD'
      | 'MODIFY'
      | 'REMOVE'
      | 'COPY'
      | 'RENAME'}`
  | 'UNRESOLVED'
  | 'RESOLVED';

export type ChangedFile = {
  path: RepoRelativePath;
  status: ChangedFileType;
  copy?: RepoRelativePath;
};

export type ChangedFiles = {
  files: ChangedFile[];
  total: number;
};

export type Status = {
  files: ChangedFile[];
  conflicts: boolean;
};

export type BranchInfo = {
  title: string;
  description: string;
  branch: BranchName;
  parents: string[];
  isHead: boolean;
  partOfTrunk: boolean;
  needsRestack: boolean;
  needsSubmit: boolean;
  author: string;
  date: string;
  pr?: {
    number: PRNumber;
    isDraft: boolean;
  };
};

export type RepoInfo = {
  remote?: {
    hostname: string;
    owner: string;
    name: string;
  };
  rootDir: string;
  dotDir: string;
  trunkBranch: string;
};
