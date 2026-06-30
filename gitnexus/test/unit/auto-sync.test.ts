import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractRepoNameFromRemoteUrl,
  loadAutoSyncConfig,
  parseAutoSyncFlag,
  parseBranchCandidates,
  resolveConfiguredCloneRoot,
  loadAutoSyncState,
  saveAutoSyncState,
  shouldAnalyzeCommit,
} from '../../src/core/auto-sync/index.js';

describe('auto-sync', () => {
  let tempDir: string;
  let gitnexusHome: string;
  let oldHome: string | undefined;
  let oldFlag: string | undefined;

  beforeEach(async () => {
    const base = path.join(process.cwd(), '.tmp-test');
    await fs.mkdir(base, { recursive: true });
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(base, 'gitnexus-auto-sync-')));
    gitnexusHome = path.join(tempDir, '.gitnexus');
    await fs.mkdir(gitnexusHome);
    oldHome = process.env.GITNEXUS_HOME;
    oldFlag = process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
    process.env.GITNEXUS_HOME = gitnexusHome;
    delete process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
  });

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = oldHome;
    if (oldFlag === undefined) delete process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
    else process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = oldFlag;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps auto sync disabled when the flag is unset or 0', () => {
    expect(parseAutoSyncFlag(undefined)).toEqual({ enabled: false, reason: 'unset' });
    expect(parseAutoSyncFlag('0')).toEqual({ enabled: false, reason: 'disabled' });
  });

  it('enables auto sync only for the explicit value 1', () => {
    expect(parseAutoSyncFlag('1')).toEqual({ enabled: true });
    expect(parseAutoSyncFlag('true')).toEqual({
      enabled: false,
      reason: 'invalid',
      message: '[auto-sync] AUTO_UPDATE_AND_ANALYZE_FLAG must be 0 or 1; got "true". Auto sync is disabled.',
    });
  });

  it('loads sync_config.yml from GITNEXUS_HOME and normalizes branch candidates', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'sync_config.yml'),
      [
        'sync_interval_minutes: 10',
        'projects:',
        '  - local_path: /tmp/repos',
        '    gitnexus_group: back_end',
        '    branch: test, master, test',
        '    remote_urls:',
        '      - git@gitee.com:qts_server/qts_account.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected config to load');
    expect(loaded.config.configPath).toBe(path.join(gitnexusHome, 'sync_config.yml'));
    expect(loaded.config.syncIntervalMinutes).toBe(10);
    expect(loaded.config.projects[0]).toMatchObject({
      localPath: '/tmp/repos',
      gitnexusGroup: 'back_end',
      branches: ['test', 'master'],
      remoteUrls: ['git@gitee.com:qts_server/qts_account.git'],
    });
  });

  it('reports missing config without throwing', async () => {
    const loaded = await loadAutoSyncConfig();

    expect(loaded).toEqual({
      ok: false,
      reason: 'missing',
      message: `[auto-sync] Missing config file: ${path.join(gitnexusHome, 'sync_config.yml')}. Auto sync is skipped.`,
    });
  });

  it('reports invalid config without throwing', async () => {
    await fs.writeFile(path.join(gitnexusHome, 'sync_config.yml'), 'projects: []\n');

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.reason).toBe('invalid');
    expect(loaded.message).toContain('[auto-sync] Invalid sync_config.yml:');
    expect(loaded.message).toContain('sync_interval_minutes must be a positive integer');
    expect(loaded.message).toContain('projects must contain at least one project');
  });

  it('rejects missing, relative, and traversal local_path values at config load', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'sync_config.yml'),
      [
        'sync_interval_minutes: 10',
        'projects:',
        '  - local_path: ../repos',
        '    branch: master',
        '    remote_urls:',
        '      - https://example.com/team/repo.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.message).toContain('local_path must be an absolute path');
  });

  it('hard-fails unsafe configured clone roots', async () => {
    await expect(resolveConfiguredCloneRoot('/')).rejects.toThrow('unsafe auto-sync clone root');
    await expect(resolveConfiguredCloneRoot(os.homedir())).rejects.toThrow('unsafe auto-sync clone root');
    await expect(resolveConfiguredCloneRoot(path.join(await fs.realpath(os.tmpdir()), 'repos'))).rejects.toThrow(
      'unsafe auto-sync clone root',
    );
    const root = path.join(tempDir, 'repos');
    await expect(resolveConfiguredCloneRoot(`${root}/../repos`)).rejects.toThrow(
      'normalized',
    );
  });

  it('rejects GitNexus internal directory descendants as clone roots', async () => {
    for (const internalDir of ['groups', 'indexes', 'quarantine']) {
      const root = path.join(gitnexusHome, internalDir, 'repo-root');
      await fs.mkdir(root, { recursive: true });

      await expect(resolveConfiguredCloneRoot(root)).rejects.toThrow('GitNexus internal directory');
    }
  });

  it('rejects symlinks in configured clone root paths', async () => {
    const realRoot = path.join(tempDir, 'real-root');
    const linkRoot = path.join(tempDir, 'link-root');
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, linkRoot);

    await expect(resolveConfiguredCloneRoot(linkRoot)).rejects.toThrow('symlink');
  });

  it('resolves safe configured clone roots and reports quarantine retention', async () => {
    const root = path.join(tempDir, 'repos');
    await fs.mkdir(root);

    await expect(resolveConfiguredCloneRoot(root)).resolves.toEqual(
      expect.objectContaining({
        root,
        quarantineRoot: path.join(gitnexusHome, 'quarantine'),
        quarantineRetentionDays: 14,
      }),
    );
  });

  it('parses branch strings and arrays with trimming and de-duplication', () => {
    expect(parseBranchCandidates('test, master, test')).toEqual(['test', 'master']);
    expect(parseBranchCandidates(['develop,master', 'develop'])).toEqual(['develop', 'master']);
  });

  it('extracts safe repository names from remote URLs', () => {
    expect(extractRepoNameFromRemoteUrl('git@gitee.com:qts_server/qts_account.git')).toBe(
      'qts_account',
    );
    expect(extractRepoNameFromRemoteUrl('https://example.com/team/repo-name.git')).toBe(
      'repo-name',
    );
  });

  it('rejects unsafe repository names without sanitizing them', () => {
    expect(() => extractRepoNameFromRemoteUrl('https://example.com/team/repo$name.git')).toThrow(
      'valid repository name',
    );
    expect(() => extractRepoNameFromRemoteUrl('https://example.com/team/..')).toThrow(
      'valid repository name',
    );
  });

  it('uses commit ids to skip unchanged analyses and retry failed prior analyses', () => {
    expect(shouldAnalyzeCommit({ currentCommit: 'abc', previousAnalyzedCommit: 'abc' })).toBe(
      false,
    );
    expect(
      shouldAnalyzeCommit({
        currentCommit: 'abc',
        previousAnalyzedCommit: 'abc',
        previousStatus: 'failed',
      }),
    ).toBe(true);
    expect(shouldAnalyzeCommit({ currentCommit: 'def', previousAnalyzedCommit: 'abc' })).toBe(
      true,
    );
  });

  it('saves state atomically and reloads it', async () => {
    const statePath = path.join(tempDir, 'auto-sync-state.json');

    await saveAutoSyncState(
      {
        '/tmp/repos/qts_account|master': {
          codeCommitId: 'abc',
          analyzedCommitId: 'abc',
          lastAnalyzeStatus: 'success',
          lastSyncTime: '2026-06-30T00:00:00.000Z',
        },
      },
      statePath,
    );

    await expect(fs.readdir(tempDir)).resolves.not.toContain(
      expect.stringContaining('auto-sync-state.json.tmp'),
    );
    await expect(loadAutoSyncState(statePath)).resolves.toEqual({
      '/tmp/repos/qts_account|master': {
        codeCommitId: 'abc',
        analyzedCommitId: 'abc',
        lastAnalyzeStatus: 'success',
        lastSyncTime: '2026-06-30T00:00:00.000Z',
      },
    });
  });

  it('returns empty state and reports corrupt state files', async () => {
    const statePath = path.join(tempDir, 'auto-sync-state.json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await fs.writeFile(statePath, '{not-json', 'utf-8');

    await expect(loadAutoSyncState(statePath)).resolves.toEqual({});

    expect(stderr).toHaveBeenCalledWith(
      `[auto-sync] Ignoring unreadable or corrupt state file: ${statePath}. State will be rebuilt.\n`,
    );
  });
});
