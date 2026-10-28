#!/usr/bin/env node
/* eslint-disable no-console */
export {};
// Disable must still work when loading the normal CLI, its dependencies, or its
// migration state fails. Keep this entry free of eager application imports.
if (process.argv[2] === 'disable') {
  void import('../scripts/installation/disable.cjs')
    .then(({ main }) => main(process.argv.slice(3)))
    .catch((error) => {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    });
} else {
  void import('./toggle_commands').catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
