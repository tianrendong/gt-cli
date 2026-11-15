import * as t from '../retype';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ExitFailedError } from '../errors';
import {
  getRepoRootPathPrecondition,
  getWorktreeGitPathPrecondition,
} from '../preconditions';
import { cuteString } from '../utils/cute_string';

/**
 * Spiffy is our utility for Schematized Persisted Files
 * Pretty simple: we use Retype to define a schema which parsed JSON is validated against
 */
export function spiffy<TSpfData, THelperFunctions>(
  template: TSpfTemplate<TSpfData, THelperFunctions>
): TSpfFactory<TSpfData, THelperFunctions> {
  const determinePath = (defaultPathOverride?: string): string => {
    const filePaths = spfAbsolutePaths(
      template.defaultLocations,
      defaultPathOverride
    );
    return filePaths.find((p) => fs.existsSync(p)) || filePaths[0];
  };
  const loadHandler = (defaultPathOverride?: string) => {
    const filePath = determinePath(defaultPathOverride);
    const _data: TSpfData = readOrInitSpf({
      filePath,
      schema: template.schema,
      initialize: template.initialize,
      removeIfInvalid: template.options?.removeIfEmpty || false,
    }) as TSpfData;
    const update = (mutator: TSpfMutator<TSpfData>) => {
      mutator(_data);
      const shouldRemoveBecauseEmpty =
        template.options?.removeIfEmpty && cuteString(_data) === cuteString({});
      if (shouldRemoveBecauseEmpty) {
        fs.removeSync(filePath);
      } else {
        atomicWrite(filePath, cuteString(_data));
      }
    };
    return {
      data: _data,
      update,
      path: filePath,
      delete: (defaultPathOverride?: string) => {
        const curPath = determinePath(defaultPathOverride);
        if (fs.existsSync(curPath)) {
          fs.removeSync(curPath);
        }
      },
      ...template.helperFunctions(_data, update),
    };
  };
  return {
    load: loadHandler,
    loadIfExists: (defaultPathOverride?: string) => {
      const curPath = determinePath(defaultPathOverride);
      if (!fs.existsSync(curPath)) {
        return undefined;
      }
      return loadHandler(defaultPathOverride);
    },
  };
}

/** Replace the file in one rename. Read-only commands hold no lock while they
 * read these files, so a reader must never see a truncated write (and then
 * discard it as malformed). Writes through symlinks, as a plain write would.
 */
function atomicWrite(filePath: string, contents: string): void {
  const target = writeTarget(filePath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.removeSync(temporary);
  }
}

function writeTarget(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Missing file, or a symlink to a missing file: create the link's target.
  try {
    return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
  } catch {
    return filePath;
  }
}

type TDefaultFileLocation = {
  relativePath: string;
  relativeTo: 'USER_HOME' | 'REPO' | 'WORKTREE';
};

type TSpfMutator<TSpfData> = (data: TSpfData) => void;
type TSpfTemplate<TSpfData, THelperFunctions> = {
  defaultLocations: TDefaultFileLocation[];
  schema: t.Schema<TSpfData>;
  initialize: () => unknown;
  helperFunctions: (
    data: TSpfData,
    update: (mutator: TSpfMutator<TSpfData>) => void
  ) => THelperFunctions;
  options?: {
    removeIfEmpty?: boolean;
    removeIfInvalid?: boolean;
  };
};

type TSpfInstance<TSpfData, THelperFunctions> = {
  readonly data: TSpfData;
  readonly update: (mutator: TSpfMutator<TSpfData>) => void;
  readonly path: string;
  delete: () => void;
} & THelperFunctions;

type TSpfFactory<TSpfData, THelperFunctions> = {
  load: (filePath?: string) => TSpfInstance<TSpfData, THelperFunctions>;
  loadIfExists: (
    filePath?: string
  ) => TSpfInstance<TSpfData, THelperFunctions> | undefined;
};

function spfAbsolutePaths(
  defaultLocations: TDefaultFileLocation[],
  defaultPathOverride?: string
): string[] {
  return (defaultPathOverride ? [defaultPathOverride] : []).concat(
    defaultLocations.map((l) =>
      path.join(
        l.relativeTo === 'REPO'
          ? getRepoRootPathPrecondition()
          : l.relativeTo === 'WORKTREE'
          ? getWorktreeGitPathPrecondition()
          : os.homedir(),
        l.relativePath
      )
    )
  );
}

function readOrInitSpf<TSpfData>({
  filePath,
  schema,
  initialize,
  removeIfInvalid,
}: {
  filePath: string;
  schema: t.Schema<TSpfData>;
  initialize: () => TSpfData;
  removeIfInvalid: boolean;
}): TSpfData {
  const spfExists = filePath && fs.existsSync(filePath);
  try {
    const parsedFile = spfExists
      ? JSON.parse(fs.readFileSync(filePath).toString()) // JSON.parse might throw.
      : initialize();
    const spfIsValid = schema(parsedFile, { logFailures: false });
    if (!spfIsValid) {
      throw new Error('Malformed data'); // expected to be caught below.
    }
    return parsedFile;
  } catch {
    if (removeIfInvalid) {
      fs.removeSync(filePath);
      return initialize();
    } else {
      throw new ExitFailedError(`Malformed data at ${filePath}`);
    }
  }
}
