#!/usr/bin/env node
// Keep command modules as the source of truth. Only registration metadata is
// generated; builders, handlers, option defaults, and validation stay live.
const fs = require('fs');
const path = require('path');

function commandManifest(directory) {
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const command = require(path.join(directory, file));
      // Modules with registration side effects (completion), inferred names, or
      // middleware keep commandDir's eager behavior. Never silently drop these.
      if (
        !command.command ||
        !(
          typeof command.command === 'string' || Array.isArray(command.command)
        ) ||
        command.middlewares
      ) {
        return { file, eager: true };
      }
      const metadata = {};
      for (const key of [
        'command',
        'aliases',
        'describe',
        'description',
        'desc',
        'deprecated',
      ]) {
        if (command[key] !== undefined) metadata[key] = command[key];
      }
      return { file, metadata };
    });
}
module.exports = { commandManifest };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const manifest = commandManifest(path.join(root, 'dist/src/commands'));
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(root, 'src/command_manifest.json'), content);
  fs.writeFileSync(path.join(root, 'dist/src/command_manifest.json'), content);
}
