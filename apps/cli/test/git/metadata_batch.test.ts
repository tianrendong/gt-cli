import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { tracer } from '../../src/lib/utils/tracer';
import {
  readMetadataRef,
  readMetadataRefs,
} from '../../src/lib/engine/metadata_ref';

describe('batched metadata reads', function () {
  this.timeout(30_000);
  let root: string, cwd: string, savedEnv: NodeJS.ProcessEnv;
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync('git', args, {
      input,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-meta-batch-'))
    );
    process.chdir(root);
    for (const key of Object.keys(process.env))
      if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    });
    git(['init', '-b', 'main']);
    git(['config', 'gc.auto', '0']);
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (name: string, raw: string | Buffer) => {
    const oid = git(['hash-object', '-w', '--stdin'], raw);
    git(['update-ref', `refs/branch-metadata/${name}`, oid]);
    return oid;
  };
  const compare = (names: string[]) =>
    expect([...readMetadataRefs(names)]).to.deep.equal(
      [...new Set(names)].map((name) => [name, readMetadataRef(name)])
    );
  const traced = (fn: () => unknown): string[][] => {
    const file = path.join(root, 'trace.jsonl');
    fs.rmSync(file, { force: true });
    process.env.GIT_TRACE2_EVENT = file;
    try {
      fn();
    } finally {
      delete process.env.GIT_TRACE2_EVENT;
    }
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((event) => event.event === 'start')
          .map((event) => event.argv.slice(1))
      : [];
  };

  it('matches singleton reads for Unicode, whitespace, missing and malformed metadata', () => {
    put(
      'nested/é',
      JSON.stringify({
        parentBranchName: 'main',
        parentBranchRevision: 'a'.repeat(40),
        prInfo: { title: '☃', body: 'first\nsecond\n' },
      })
    );
    put('spaces', ' \n{ "parentBranchName": "main" }\n');
    put('bom', '\ufeff{"parentBranchName":"main"}\ufeff');
    put('nbsp', '\u00a0{"parentBranchName":"main"}\u00a0');
    put('invalid-json', '{\n');
    put('invalid-schema', '{"parentBranchName": 1}');
    put('binary', Buffer.from([0, 255, 0, 10]));
    compare([
      'nested/é',
      'spaces',
      'bom',
      'nbsp',
      'missing',
      'invalid-json',
      'invalid-schema',
      'binary',
      'nested/é',
    ]);
    expect(
      traced(() => readMetadataRefs(['nested/é', 'missing', 'spaces']))
    ).to.have.length(1);
  });

  it('retains subprocess tracing without serializing binary metadata into spans', () => {
    put(
      'one',
      '{"parentBranchName":"main","prInfo":{"title":"private title"}}'
    );
    const savedId = tracer.currentSpanId,
      savedSpans = tracer.allSpans;
    tracer.currentSpanId = undefined;
    tracer.allSpans = [];
    try {
      tracer.spanSync(
        { name: 'command', resource: 'metadata-batch-test' },
        () => {
          readMetadataRefs(['one']);
          return undefined;
        }
      );
      const json = tracer.flushJson();
      const spans = JSON.parse(json)[0].filter(
        (span: { resource: string }) => span.resource === 'readMetadataRefs'
      );
      expect(spans).to.have.length(1);
      expect(spans[0].meta.exitCode).to.equal('0');
      expect(json).not.to.include('private title');
    } finally {
      tracer.currentSpanId = savedId;
      tracer.allSpans = savedSpans;
    }
  });

  it('retains tolerance for non-blob metadata and packed objects/refs', () => {
    git(['commit', '--allow-empty', '-m', 'initial']);
    git(['update-ref', 'refs/branch-metadata/commit', 'HEAD']);
    git(['update-ref', 'refs/branch-metadata/tree', 'HEAD^{tree}']);
    git(['tag', '-am', 'tag', 'annotated']);
    git(['update-ref', 'refs/branch-metadata/tag', 'refs/tags/annotated']);
    put('blob', '{"parentBranchName":"main"}');
    git(['pack-refs', '--all']);
    git(['repack', '-ad']);
    compare(['commit', 'tree', 'tag', 'blob']);
  });

  it('preserves pretty-print semantics even for literally-written invalid commit objects', () => {
    const oid = git(
      ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'],
      '{"parentBranchName":"main"}'
    );
    // update-ref rejects malformed commit objects. Construct a corrupt loose
    // ref deliberately to exercise the tolerant legacy reader, not Git writes.
    const directory = path.join(root, '.git/refs/branch-metadata');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'literal'), oid + '\n');
    compare(['literal']);
  });

  it('handles multiple bounded chunks without spawning per branch', () => {
    const oid = git(
      ['hash-object', '-w', '--stdin'],
      '{"parentBranchName":"main"}'
    );
    const names = Array.from({ length: 260 }, (_, i) => `branch-${i}`);
    git(
      ['update-ref', '--stdin'],
      names.map((n) => `update refs/branch-metadata/${n} ${oid}\n`).join('')
    );
    const commands = traced(() => {
      const actual = readMetadataRefs(names);
      expect(actual.size).to.equal(names.length);
      for (const name of names)
        expect(actual.get(name)).to.deep.equal({ parentBranchName: 'main' });
    });
    expect(commands).to.have.length(3);
    expect(
      commands.every((args) => args.join(' ') === 'cat-file --batch')
    ).to.equal(true);
    expect(
      traced(() => expect(readMetadataRefs([]).size).to.equal(0))
    ).to.have.length(0);
  });

  it('lets Git apply replacement objects rather than reading loose files itself', () => {
    const original = put('one', '{"parentBranchName":"old"}');
    const replacement = put('two', '{"parentBranchName":"new"}');
    git(['replace', original, replacement]);
    compare(['one', 'two']);
    expect(readMetadataRefs(['one']).get('one')).to.deep.equal({
      parentBranchName: 'new',
    });
  });

  for (const response of [
    'exit 1',
    "printf 'malformed\\n'",
    "printf '%s blob 100\\nshort\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    it(`falls back to singleton semantics on unsupported/incomplete batch output: ${response}`, () => {
      put('one', '{"parentBranchName":"main"}');
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\nif [ "$1" = cat-file ] && [ "$2" = --batch ]; then\n${response}\nexit 0\nfi\nexec '${realGit.replace(
          /'/g,
          "'\\''"
        )}' "$@"\n`,
        { mode: 0o755 }
      );
      process.env.PATH = bin + path.delimiter + process.env.PATH;
      compare(['one', 'missing']);
    });
  }
});
