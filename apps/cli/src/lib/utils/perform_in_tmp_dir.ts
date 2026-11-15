import fs from 'fs-extra';
import tmp from 'tmp';

export function performInTmpDir<T>(handler: (dirPath: string) => T): T {
  const tmpDir = tmp.dirSync();
  const cleanup = () => {
    fs.emptyDirSync(tmpDir.name);
    tmpDir.removeCallback();
  };
  try {
    const result: T = handler(tmpDir.name);
    if (result instanceof Promise)
      return result.finally(cleanup) as unknown as T;
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}
