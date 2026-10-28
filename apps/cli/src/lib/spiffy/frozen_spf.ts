import * as t from '../retype';
import { spiffy } from './spiffy';

export const frozenConfigFactory = spiffy({
  schema: t.shape({ branches: t.array(t.string) }),
  defaultLocations: [{ relativePath: 'gt-frozen', relativeTo: 'REPO' }],
  initialize: () => ({ branches: [] }),
  helperFunctions: () => ({}),
});
