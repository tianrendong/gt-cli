import { FreezeArgs, setFrozen } from './freeze';
export { builder } from './freeze';
export const command = 'unfreeze [branch]';
export const description =
  'Mark a branch and any upstack branches as unfrozen, enabling local modifications.';
export const handler = async (argv: FreezeArgs): Promise<void> =>
  setFrozen(argv, false);
