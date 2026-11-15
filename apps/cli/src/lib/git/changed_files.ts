export type TChangedFile = {
  path: string;
  status: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed';
  from: string | undefined;
};

export type TStatusFile = {
  path: string;
  status:
    | 'added'
    | 'deleted'
    | 'copied'
    | 'renamed'
    | 'modified'
    | 'unresolved';
  staged: 'full' | 'partial' | 'none';
  from: string | undefined;
};
