/* eslint-disable */
const pkg = require('../package.json');
const requiredVersion = (pkg.runtimeEngines || pkg.engines).node;
const semver = require('semver');

try {
  if (!semver.satisfies(process.version, requiredVersion)) {
    console.error(
      require('chalk').red(
        `Required Node.js version ${requiredVersion} not satisfied with current version ${process.version}.`
      )
    );
    process.exit(1);
  }
} catch {
  console.error(
    `Unable to validate Node.js version. Required: ${requiredVersion}.`
  );
}
