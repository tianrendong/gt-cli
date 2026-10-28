import fs from 'fs';
import path from 'path';
import { ExitFailedError } from '../errors';
import { atomicJSON } from '../github/stack_file';

type Receipt = {
  fingerprint: string;
  status: 'pending' | 'submitted';
};
type State = {
  schemaVersion: 1;
  repository: string;
  receipts: Record<string, Receipt>;
};

/** Shared across worktrees, under gt's common lock; intentionally not undoable. */
export class GraphiteSubmissionState {
  private readonly file: string;
  private readonly state: State;
  private original: string | undefined;

  constructor(commonDirectory: string, repository: string) {
    this.file = path.join(commonDirectory, 'gt-graphite-submit.json');
    try {
      const stat = fs.lstatSync(this.file, { throwIfNoEntry: false });
      if (
        stat &&
        (!stat.isFile() ||
          stat.uid !== process.getuid() ||
          stat.size > 16 * 1024 * 1024)
      )
        throw Error('Unsafe file');
      this.original = stat ? fs.readFileSync(this.file, 'utf8') : undefined;
      this.state =
        this.original === undefined
          ? { schemaVersion: 1, repository, receipts: {} }
          : JSON.parse(this.original);
      if (
        this.state.schemaVersion !== 1 ||
        this.state.repository !== repository ||
        !this.state.receipts ||
        Array.isArray(this.state.receipts) ||
        typeof this.state.receipts !== 'object' ||
        Object.entries(this.state.receipts).some(
          ([number, receipt]) =>
            !/^[1-9][0-9]*$/.test(number) ||
            !receipt ||
            !/^[0-9a-f]{64}$/.test(receipt.fingerprint) ||
            !['pending', 'submitted'].includes(receipt.status)
        )
      )
        throw Error('Unknown schema');
    } catch {
      throw new ExitFailedError(
        'Invalid Graphite submission receipts. File left untouched; resolve gt-graphite-submit.json before mirroring.'
      );
    }
  }

  submitted(number: number, fingerprint: string): boolean {
    const receipt = this.state.receipts[String(number)];
    return (
      receipt?.status === 'submitted' && receipt.fingerprint === fingerprint
    );
  }

  record(number: number, fingerprint: string, status: Receipt['status']): void {
    const stat = fs.lstatSync(this.file, { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new ExitFailedError(
        'Graphite receipt path changed. No file overwritten.'
      );
    const current = stat ? fs.readFileSync(this.file, 'utf8') : undefined;
    if (current !== this.original)
      throw new ExitFailedError(
        'Graphite receipts changed concurrently. No newer receipt was overwritten.'
      );
    this.state.receipts[String(number)] = { fingerprint, status };
    atomicJSON(this.file, this.state);
    this.original = fs.readFileSync(this.file, 'utf8');
  }
}
