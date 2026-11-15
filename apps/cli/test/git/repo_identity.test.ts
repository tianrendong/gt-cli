import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { repoConfigFactory } from '../../src/lib/spiffy/repo_config_spf';
import {
  getBranchesAndMetadata,
  getBranchNamesAndRevisions,
} from '../../src/lib/git/sorted_branch_names';
import { getMetadataRefList } from '../../src/lib/engine/metadata_ref';

describe('batched repository identity', function () {
  this.timeout(15_000);
  let root: string, cwd: string, savedEnv: NodeJS.ProcessEnv;
  const git = (...args: string[]) =>
    execFileSync('git', args, { stdio: 'pipe' });
  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-identity-'))
    );
    process.chdir(root);
    for (const key of Object.keys(process.env))
      if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    git('init', '-b', 'main');
    git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const load = () => repoConfigFactory.load(path.join(root, 'config.json'));

  it('matches all three existing getters with every combination of overrides', () => {
    for (let mask = 0; mask < 8; mask++) {
      const config = load();
      config.update((data) => {
        data.host = mask & 1 ? 'enterprise.example' : undefined;
        data.owner = mask & 2 ? 'override-owner' : undefined;
        data.name = mask & 4 ? 'override-name' : undefined;
      });
      expect(config.getRepoIdentity()).to.deep.equal({
        host: config.getRepoHost(),
        owner: config.getRepoOwner(),
        name: config.getRepoName(),
      });
    }
  });

  it('uses one git call per identity, but sees subsequent remote/config changes', () => {
    const config = load();
    const trace = path.join(root, 'trace.jsonl');
    process.env.GIT_TRACE2_EVENT = trace;
    expect(config.getRepoIdentity()).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      name: 'repo',
    });
    delete process.env.GIT_TRACE2_EVENT;
    const starts = fs
      .readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start');
    expect(starts).to.have.length(1);
    git('remote', 'set-url', 'origin', 'https://github.com/other/changed.git');
    expect(config.getRepoIdentity().name).to.equal('changed');
    git('remote', 'add', 'upstream', 'https://github.com/upstream/project.git');
    config.setRemote('upstream');
    expect(config.getRepoIdentity().owner).to.equal('upstream');
    config.update((data) => {
      data.owner = 'explicit';
    });
    expect(config.getRepoIdentity().owner).to.equal('explicit');
  });

  it('keeps batched ref seed bytes identical, including ambiguous names and metadata order', () => {
    const matchesLegacy = () =>
      expect(JSON.stringify(getBranchesAndMetadata())).to.equal(
        JSON.stringify({
          gitBranchNamesAndRevisions: getBranchNamesAndRevisions(),
          metadataRefList: getMetadataRefList(),
        })
      );
    matchesLegacy(); // Unborn repository.
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    );
    for (const name of ['z', 'a/nested', 'é']) {
      git('branch', name);
      git('update-ref', `refs/branch-metadata/${name}`, 'HEAD');
    }
    git('tag', 'z'); // refname:short must keep Git's ambiguity handling.
    git('tag', 'heads/z');
    matchesLegacy();
    git('pack-refs', '--all');
    matchesLegacy();
    git('branch', '-D', 'a/nested');
    matchesLegacy(); // Orphan metadata remains in the seed for reconciliation.
  });

  it('preserves validation and error order when a remote parses to empty fields', () => {
    for (const url of [
      'https://github.com/owner/.git',
      'ssh:///owner/repo',
      'ssh:///owner/.git',
    ]) {
      git('remote', 'set-url', 'origin', url);
      for (let mask = 0; mask < 8; mask++) {
        const config = load();
        config.update((data) => {
          data.host = mask & 1 ? 'host' : undefined;
          data.owner = mask & 2 ? 'owner' : undefined;
          data.name = mask & 4 ? 'name' : undefined;
        });
        let legacy: ReturnType<typeof config.getRepoIdentity> | undefined;
        let legacyError: string | undefined;
        try {
          legacy = {
            host: config.getRepoHost(),
            owner: config.getRepoOwner(),
            name: config.getRepoName(),
          };
        } catch (error) {
          legacyError = error.message;
        }
        if (legacyError !== undefined) {
          expect(() => config.getRepoIdentity()).to.throw(legacyError);
        } else {
          expect(config.getRepoIdentity()).to.deep.equal(legacy);
        }
      }
    }
  });

  it('requires no remote when fully explicit, and preserves inference failures', () => {
    git('remote', 'remove', 'origin');
    const config = load();
    let legacyError: string | undefined;
    try {
      config.getRepoHost();
    } catch (error) {
      legacyError = error.message;
    }
    expect(legacyError).to.be.a('string');
    expect(() => config.getRepoIdentity()).to.throw(legacyError);
    config.update((data) => {
      data.host = 'host';
      data.owner = 'owner';
      data.name = 'name';
    });
    expect(config.getRepoIdentity()).to.deep.equal({
      host: 'host',
      owner: 'owner',
      name: 'name',
    });
  });
});
