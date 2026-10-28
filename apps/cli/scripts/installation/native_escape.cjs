// Native routing must not depend on migration state, SQLite, or the clone's runtime.
// Keep this module dependency-free: it is also used by the disable rescue command.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const marker = (common) => path.join(common, 'gt-cli-native');
const routerPath = (directory, slot) =>
  path.join(
    path.dirname(slot),
    `.gt-gh-router-${hash(directory).slice(0, 24)}`
  );
const globalMarker = (plan) =>
  (plan.router || routerPath(plan.directory, plan.slot)) + '.disabled';

function read(file) {
  try {
    if (!fs.lstatSync(file).isFile())
      throw Error(`Not a regular file: ${file}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function atomicWrite(file, content, mode = 0o600) {
  const temporary = `${file}.${process.pid}-${crypto
    .randomBytes(6)
    .toString('hex')}`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function commonDirectory(cwd) {
  const result = spawnSync(
    'git',
    [
      '--no-optional-locks',
      '-C',
      cwd,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  if (result.status !== 0)
    throw Error(
      result.stderr?.trim() ||
        result.error?.message ||
        `Cannot locate Git directory for ${cwd}.`
    );
  return fs.realpathSync(result.stdout.replace(/\n$/, ''));
}

function routerContent(directory, native, router) {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw Error('Executable switching requires a POSIX user ID.');
  return `#!/bin/sh
# Managed gt dispatcher. Native escape runs before Node or any gt-cli state reader.
if [ "\${GT_GH_PROBING_NATIVE:-}" = 1 ]; then exit 1; fi
GT_UID=$(/usr/bin/id -u) || exit 1
if [ "$GT_UID" != ${quote(String(uid))} ] || [ -e ${quote(
    router + '.disabled'
  )} ]; then
  exec ${quote(native)} "$@"
fi
gt_cli_native_escape() {
  GT_CWD=.
  GT_NEXT_CWD=0
  for GT_ARG in "$@"; do
    if [ "$GT_NEXT_CWD" = 1 ]; then GT_CWD=$GT_ARG; GT_NEXT_CWD=0; continue; fi
    case "$GT_ARG" in
      --) break ;;
      --cwd) GT_NEXT_CWD=1 ;;
      --cwd=*) GT_CWD=\${GT_ARG#--cwd=} ;;
    esac
  done
  GT_COMMON=$(git --no-optional-locks -C "$GT_CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  if [ -e "$GT_COMMON/gt-cli-native" ]; then
    exec ${quote(native)} "$@"
  fi
}
gt_cli_native_escape "$@"
exec ${quote(path.join(directory, 'node'))} ${quote(
    path.join(directory, 'bootstrap.cjs')
  )} "$@"
`;
}

function nativeReceipt(router, native) {
  const file = router + '.native';
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isSymbolicLink())
    throw Error(`Native recovery link was replaced: ${file}`);
  if (stat && fs.readlinkSync(file) === native) return;
  const temporary = `${file}.${process.pid}-${crypto
    .randomBytes(6)
    .toString('hex')}`;
  try {
    fs.symlinkSync(native, temporary);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// A concurrent disable always wins over an enable that started before it.
function selectionSnapshot(plan, common) {
  const files = [globalMarker(plan), ...(common ? [marker(common)] : [])];
  return files.map((file) => ({ file, content: read(file) }));
}
function clearSelection(snapshot) {
  for (const { file, content } of snapshot) {
    if (read(file) !== content)
      throw Error(
        'A concurrent gt-cli disable selected native Graphite. Retry enable explicitly; native routing was kept.'
      );
  }
  for (const { file, content } of snapshot)
    if (content !== undefined) fs.unlinkSync(file);
}

function canonical(file) {
  return fs.existsSync(file)
    ? fs.realpathSync(file)
    : path.join(canonical(path.dirname(file)), path.basename(file));
}
function entry(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) return { link: fs.readlinkSync(file) };
  if (stat.isFile()) return { hash: hash(fs.readFileSync(file)) };
  throw Error(`Not an executable file or symlink: ${file}`);
}
function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Read only the recovery identity. A malformed launcher record is diagnostic,
 * never a prerequisite for returning control to the preserved executable. */
function inspectLauncher(explicitSlot) {
  const candidates = (process.env.PATH || '')
    .split(path.delimiter)
    .map((directory) => path.resolve(directory || '.', 'gt'));
  const selected = candidates.find((file) => {
    try {
      const stat = fs.lstatSync(file);
      if (
        stat.isSymbolicLink() &&
        path.basename(fs.readlinkSync(file)).startsWith('.gt-gh-router-')
      )
        return true;
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (!selected)
    throw Error(
      'No gt executable found on PATH. Install native Graphite, then retry gt-cli disable.'
    );
  const slot = path.join(fs.realpathSync(path.dirname(selected)), 'gt');
  if (
    explicitSlot &&
    canonical(path.dirname(path.resolve(explicitSlot))) +
      path.sep +
      path.basename(explicitSlot) !==
      slot
  )
    throw Error(
      '--gt-path must name the gt entry currently selected by PATH. No other executable will be replaced.'
    );
  if (process.getuid && fs.lstatSync(slot).uid !== process.getuid())
    throw Error(
      `Cannot change another OS user's gt entry: ${slot}. Install native Graphite in a user-owned PATH location.`
    );
  const directory = canonical(
    path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
      'gt-gh/launchers',
      hash(slot).slice(0, 24)
    )
  );
  const file = path.join(directory, 'launcher.json');
  const warnings = [];
  let bytes, record;
  try {
    bytes = read(file);
    if (bytes !== undefined) {
      record = JSON.parse(bytes);
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw Error('Invalid launcher record.');
    }
  } catch (error) {
    record = undefined;
    warnings.push(`Launcher state could not be read: ${error.message}`);
  }
  const current = entry(slot);
  const expectedRouter = routerPath(directory, slot);
  const linked =
    current?.link && path.resolve(path.dirname(slot), current.link);
  const owned =
    linked === expectedRouter ||
    (linked &&
      path.dirname(linked) === path.dirname(slot) &&
      path.basename(linked).startsWith('.gt-gh-router-'));
  const router = owned ? linked : expectedRouter;
  return {
    slot,
    directory,
    file,
    bytes,
    record,
    warnings,
    current,
    router,
    owned,
  };
}

function nativeBinary(plan) {
  const candidates = [];
  try {
    candidates.push(fs.readlinkSync(plan.router + '.native'));
  } catch {
    /* Legacy install. */
  }
  if (typeof plan.record?.native?.path === 'string')
    candidates.push(plan.record.native.path);
  // Older installations already embed the preserved path for other OS users.
  // Decode only our exact single-quoted exec syntax; never evaluate shell text.
  try {
    const content = fs.readFileSync(plan.router, 'utf8');
    for (const line of content.split('\n')) {
      const match = /^  exec (.+) "\$@"$/.exec(line);
      if (!match) continue;
      const decoded = match[1].slice(1, -1).replace(/'\\''/g, "'");
      if (quote(decoded) === match[1]) candidates.push(decoded);
    }
  } catch {
    /* The router itself may be gone. */
  }
  if (!plan.owned) candidates.unshift(plan.slot);
  for (const directory of (process.env.PATH || '').split(path.delimiter))
    candidates.push(path.resolve(directory || '.', 'gt'));
  // Regular native binaries were preserved beside the PATH entry, independently
  // of the install/runtime/launcher record. Prefer the most recent surviving one.
  try {
    for (const name of fs
      .readdirSync(path.dirname(plan.slot))
      .filter((name) => name.startsWith('.gt-gh-native-'))
      .sort()
      .reverse())
      candidates.push(path.join(path.dirname(plan.slot), name, 'gt'));
  } catch {
    /* Directory listing is not required to run a known native binary. */
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!path.isAbsolute(candidate)) continue;
      const binary = fs.realpathSync(candidate);
      if (binary === plan.router) continue;
      fs.accessSync(binary, fs.constants.X_OK);
      const result = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, GT_GH_PROBING_NATIVE: '1' },
      });
      if (
        result.status === 0 &&
        /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.stdout.trim())
      )
        return { path: binary, version: result.stdout.trim() };
    } catch {
      /* Try another native installation, never require the old digest/version. */
    }
  }
  throw Error(
    'Native Graphite is missing or cannot run. Install native Graphite and retry gt-cli disable. Recovery state was kept; no working files were reset.'
  );
}

function assertEntry(plan) {
  if (!sameEntry(entry(plan.slot), plan.current))
    throw Error(
      `The gt PATH entry changed concurrently: ${plan.slot}. Retry disable; no newer executable was overwritten.`
    );
}
function restoreNative(plan, native) {
  assertEntry(plan);
  if (!plan.owned) {
    if (fs.realpathSync(plan.slot) === native.path) return false;
    throw Error(
      `The gt entry is no longer our dispatcher: ${plan.slot}. Native Graphite is available at ${native.path}; no unrelated executable was overwritten.`
    );
  }
  const temporary = `${plan.slot}.native-${process.pid}-${crypto
    .randomBytes(6)
    .toString('hex')}`;
  try {
    fs.symlinkSync(native.path, temporary);
    assertEntry(plan);
    fs.renameSync(temporary, plan.slot);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

/** Routing-only recovery. Never edit refs, SQLite, operation journals, or switch
 * manifests, and never replay an export after native routing has been selected. */
function escape(plan, native, options) {
  assertEntry(plan);
  const { common, global, warnings, reason } = options;
  const selection =
    JSON.stringify(
      {
        schemaVersion: 1,
        native: native.path,
        handoff: 'incomplete',
        reason,
        id: crypto.randomBytes(12).toString('hex'),
      },
      null,
      2
    ) + '\n';
  let all = global;
  if (!global && !plan.record) {
    all = true;
    warnings.push(
      'Launcher registrations are unreadable. Restoring native Graphite globally; all recovery data is retained.'
    );
  }
  if (common) {
    try {
      atomicWrite(marker(common), selection);
    } catch (error) {
      warnings.push(
        `Could not save repository-native selection: ${error.message}. Restoring native Graphite globally instead.`
      );
      all = true;
    }
  }
  const registered = Array.isArray(plan.record?.repositories)
    ? plan.record.repositories.filter(
        (key) => typeof key === 'string' && path.isAbsolute(key)
      )
    : [];
  const implementations = Object.fromEntries(
    Object.entries(
      plan.record?.implementations &&
        typeof plan.record.implementations === 'object'
        ? plan.record.implementations
        : {}
    )
      .filter(([key]) => path.isAbsolute(key))
      .map(([key, value]) => [
        key,
        {
          mode: value?.mode === 'gt-gh' ? 'gt-gh' : 'graphite',
          worktrees: Array.isArray(value?.worktrees)
            ? value.worktrees.filter(
                (root) => typeof root === 'string' && path.isAbsolute(root)
              )
            : [],
        },
      ])
  );
  if (all) {
    for (const key of new Set([...registered, ...Object.keys(implementations)]))
      if (typeof key === 'string')
        implementations[key] = {
          ...implementations[key],
          mode: 'graphite',
          worktrees: implementations[key]?.worktrees || [],
        };
  } else if (common)
    implementations[common] = {
      ...implementations[common],
      mode: 'graphite',
      worktrees: implementations[common]?.worktrees || [],
    };
  const remaining = all ? [] : registered.filter((key) => key !== common);
  const needed =
    !all &&
    (remaining.length > 0 ||
      plan.record?.defaultMode === 'gt-gh' ||
      Object.values(implementations).some(
        (selection) => selection.mode === 'gt-gh'
      ));
  if (!needed) {
    try {
      atomicWrite(globalMarker(plan), selection);
    } catch (error) {
      warnings.push(
        `Could not record global native selection: ${error.message}`
      );
    }
  }
  let backup;
  try {
    if (plan.bytes !== undefined) {
      const archive = path.join(
        plan.directory,
        'native-recovery',
        `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
      );
      fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
      backup = path.join(archive, 'launcher.json');
      atomicWrite(backup, plan.bytes);
    }
    if (plan.record && read(plan.file) === plan.bytes) {
      const record = {
        ...plan.record,
        implementations,
        repositories: remaining,
        ...(all ? { schemaVersion: 2, defaultMode: 'graphite' } : {}),
      };
      if (all) {
        delete record.pendingBindings;
        delete record.registrations;
      } else if (common) {
        if (record.pendingBindings)
          record.pendingBindings = {
            ...record.pendingBindings,
            repositories: record.pendingBindings.repositories.filter(
              (key) => key !== common
            ),
          };
        if (record.registrations) {
          record.registrations = { ...record.registrations };
          delete record.registrations[common];
        }
      }
      if (needed && plan.owned) {
        assertEntry(plan);
        const content = routerContent(plan.directory, native.path, plan.router);
        nativeReceipt(plan.router, native.path);
        atomicWrite(plan.router, content, 0o755);
        record.routerDigest = hash(content);
      }
      record.phase = needed ? 'active' : 'restored';
      atomicWrite(plan.file, JSON.stringify(record, null, 2) + '\n');
    } else if (needed) {
      // A damaged record may remain unreadable to the clone. The shell escape
      // still serves this repository before reading that record or starting Node.
      assertEntry(plan);
      nativeReceipt(plan.router, native.path);
      atomicWrite(
        plan.router,
        routerContent(plan.directory, native.path, plan.router),
        0o755
      );
    }
  } catch (error) {
    warnings.push(
      `Launcher bookkeeping was kept for recovery: ${error.message}`
    );
    // Do not strand a scoped disable behind an old/broken router.
    if (needed) {
      warnings.push(
        'Restoring native Graphite globally because scoped routing could not be installed.'
      );
      try {
        atomicWrite(globalMarker(plan), selection);
      } catch (error) {
        warnings.push(`Could not save the native guard: ${error.message}`);
      }
      return {
        restored: restoreNative(plan, native),
        remaining: [],
        backup,
        global: true,
      };
    }
  }
  return {
    restored: needed ? false : restoreNative(plan, native),
    remaining,
    backup,
    global: all,
  };
}

module.exports = {
  atomicWrite,
  clearSelection,
  commonDirectory,
  escape,
  globalMarker,
  hash,
  inspectLauncher,
  marker,
  nativeBinary,
  nativeReceipt,
  read,
  routerContent,
  routerPath,
  selectionSnapshot,
};
