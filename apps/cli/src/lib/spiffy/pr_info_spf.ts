import { prInfoToUpsertSchema } from '../api/pr_info';
import * as t from '../retype';
import { spiffy } from './spiffy';

export const prInfoConfigFactory = spiffy({
  schema: t.shape({
    prInfoToUpsert: prInfoToUpsertSchema,
  }),
  defaultLocations: [
    {
      relativePath: '.graphite_pr_info',
      relativeTo: 'REPO',
    },
  ],
  initialize: () => {
    return {
      message: undefined,
    };
  },
  helperFunctions: () => {
    return {};
  },
  options: { removeIfEmpty: true },
});
