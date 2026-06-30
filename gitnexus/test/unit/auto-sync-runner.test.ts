import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  addRepoToGroup,
  getConfiguredRepoPath,
  maybeStartAutoSyncFromEnv,
  runAutoSyncOnce,
} from '../../src/core/auto-sync/index.js';
import type { AutoSyncConfig, AutoSyncRunDeps } from '../../src/core/auto-sync/index.js';

const config: AutoSyncConfig = {
  configPath: '/tmp/.gitnexus/sync_config.yml',
  syncIntervalMinutes: 10,
  projects: [
    {
      localPath: '/tmp/repos',
      gitnexusGroup: 'back_end',
      branches: ['master'],
      remoteUrls: ['git@gitee.com:qts_server/qts_account.git'],
    },
  ],
};

const cloneRoot = {
  root: '/tmp/repos',
  quarantineRoot: '/tmp/.gitnexus/quarantine',
  quarantineRetentionDays: 14,
};

function withCloneRoot(deps: Partial<AutoSyncRunDeps>): Partial<AutoSyncRunDeps> {
  return {
    resolveCloneRoot: vi.fn(async () => cloneRoot),
    ...deps,
  };
}

describe('auto-sync runner', () => {
  it('runs clone, analyzes changed commits, registers the repo, and syncs changed groups', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runFullAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({
        '/tmp/repos/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'success',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 1, skippedAnalysis: 0, failed: 0 });
    expect(deps.cloneOrPull).toHaveBeenCalledWith(
      'git@gitee.com:qts_server/qts_account.git',
      '/tmp/repos/qts_account',
      undefined,
      {
        allowedCloneRoot: '/tmp/repos',
        expectedRepoName: 'qts_account',
        quarantineRoot: '/tmp/.gitnexus/quarantine',
      },
    );
    expect(deps.getCurrentBranch).toHaveBeenCalledWith('/tmp/repos/qts_account');
    expect(deps.runFullAnalysis).toHaveBeenCalledWith(
      '/tmp/repos/qts_account',
      { branch: 'master', skipAgentsMd: true, skipSkills: true },
      { onProgress: expect.any(Function) },
    );
    expect(deps.registerRepo).toHaveBeenCalledWith(
      '/tmp/repos/qts_account',
      expect.objectContaining({ lastCommit: 'commit-2', branch: 'master' }),
      { name: 'qts_account', allowDuplicateName: true },
    );
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
  });

  it('skips analysis when commit id has not changed', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-1'),
      runFullAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({
        '/tmp/repos/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'success',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.analyzed).toBe(0);
    expect(result.skippedAnalysis).toBe(1);
    expect(deps.runFullAnalysis).not.toHaveBeenCalled();
    expect(deps.syncGroupByName).not.toHaveBeenCalled();
  });

  it('uses local_path plus repo name as the clone target', async () => {
    expect(getConfiguredRepoPath(config.projects[0], 'qts_account')).toBe('/tmp/repos/qts_account');

    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runFullAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
    });

    await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(deps.cloneOrPull).toHaveBeenCalledWith(
      'git@gitee.com:qts_server/qts_account.git',
      '/tmp/repos/qts_account',
      undefined,
      {
        allowedCloneRoot: '/tmp/repos',
        expectedRepoName: 'qts_account',
        quarantineRoot: '/tmp/.gitnexus/quarantine',
      },
    );
  });

  it('skips analysis when the checked out branch is not configured', async () => {
    const warnLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/qts_account'),
      getCurrentBranch: vi.fn(() => 'develop'),
      getCurrentCommit: vi.fn(),
      runFullAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: warnLogger, error: vi.fn() },
    });

    expect(result).toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 1, failed: 0 });
    expect(deps.getCurrentCommit).not.toHaveBeenCalled();
    expect(deps.runFullAnalysis).not.toHaveBeenCalled();
    expect(deps.addRepoToGroup).not.toHaveBeenCalled();
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Skip analysis for /tmp/repos/qts_account; current branch develop is not in configured branches: master.',
    );
  });

  it('skips analysis when the checked out repository is detached', async () => {
    const warnLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/qts_account'),
      getCurrentBranch: vi.fn(() => undefined),
      getCurrentCommit: vi.fn(),
      runFullAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: warnLogger, error: vi.fn() },
    });

    expect(result).toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 1, failed: 0 });
    expect(deps.getCurrentCommit).not.toHaveBeenCalled();
    expect(deps.runFullAnalysis).not.toHaveBeenCalled();
    expect(deps.addRepoToGroup).not.toHaveBeenCalled();
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Skip analysis for /tmp/repos/qts_account; current branch <detached> is not in configured branches: master.',
    );
  });

  it('isolates repository, analysis, and group sync failures', async () => {
    const errorLogger = vi.fn();
    const failingConfig: AutoSyncConfig = {
      ...config,
      projects: [
        {
          ...config.projects[0],
          remoteUrls: [
            'git@gitee.com:qts_server/failing_sync.git',
            'git@gitee.com:qts_server/qts_account.git',
          ],
        },
      ],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (remoteUrl) => {
        if (remoteUrl.includes('failing_sync')) throw new Error('sync failed');
        return '/tmp/repos/qts_account';
      }),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runFullAnalysis: vi.fn(async () => {
        throw new Error('analysis failed');
      }),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {
        throw new Error('group sync failed');
      }),
    });

    const result = await runAutoSyncOnce(failingConfig, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogger },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 0, failed: 3 });
    expect(deps.cloneOrPull).toHaveBeenCalledTimes(2);
    expect(deps.registerRepo).not.toHaveBeenCalled();
    expect(deps.addRepoToGroup).toHaveBeenCalledWith(failingConfig.projects[0], 'qts_account');
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/qts_account|master': expect.objectContaining({
          codeCommitId: 'commit-2',
          lastAnalyzeStatus: 'failed',
        }),
      }),
    );
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Repository sync failed for git@gitee.com:qts_server/failing_sync.git'),
    );
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Analysis failed for /tmp/repos/qts_account'),
    );
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Group sync failed for back_end'),
    );
  });

  it('detects existing groupPath to registryName mappings as already joined', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-group-'));
    try {
      process.env.GITNEXUS_HOME = tempDir;
      const groupDir = path.join(tempDir, 'groups', 'back_end');
      await fs.mkdir(groupDir, { recursive: true });
      await fs.writeFile(
        path.join(groupDir, 'group.yaml'),
        [
          'version: 1',
          'name: back_end',
          'repos:',
          '  hr/hiring/backend: qts_account',
        ].join('\n'),
      );

      await expect(addRepoToGroup({ gitnexusGroup: 'back_end' }, 'qts_account')).resolves.toBe(
        false,
      );

      await expect(fs.readFile(path.join(groupDir, 'group.yaml'), 'utf-8')).resolves.toContain(
        'hr/hiring/backend: qts_account',
      );
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('auto-sync starter', () => {
  it('does not read config or register timers when the flag is disabled', async () => {
    const previous = process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
    process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = '0';
    const setIntervalFn = vi.fn() as unknown as typeof setInterval;

    try {
      const handle = await maybeStartAutoSyncFromEnv({ setIntervalFn });
      expect(handle).toBeNull();
      expect(setIntervalFn).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
      else process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = previous;
    }
  });

  it('registers a clearable timer when enabled with a valid config', async () => {
    const previousFlag = process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-starter-'));
    const timer = { unref: vi.fn() };
    const setIntervalFn = vi.fn(() => timer) as unknown as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
    const runOnce = vi.fn(async () => ({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 }));

    try {
      process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = '1';
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'sync_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    gitnexus_group: back_end',
          '    branch: master',
          '    remote_urls:',
          '      - git@gitee.com:qts_server/qts_account.git',
        ].join('\n'),
      );

      const handle = await maybeStartAutoSyncFromEnv({ setIntervalFn, clearIntervalFn, runOnce });

      expect(handle).not.toBeNull();
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 300_000);
      expect(timer.unref).toHaveBeenCalled();

      handle?.stop();

      expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    } finally {
      if (previousFlag === undefined) delete process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
      else process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = previousFlag;
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips overlapping scheduled runs while a previous run is active', async () => {
    const previousFlag = process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-starter-'));
    const timer = { unref: vi.fn() };
    let scheduled: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      scheduled = fn;
      return timer;
    }) as unknown as typeof setInterval;
    const stderr = { write: vi.fn() };
    let releaseRun: (() => void) | undefined;
    const runOnce = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          releaseRun = () => resolve({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 });
        }),
    );

    try {
      process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = '1';
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'sync_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - https://example.com/team/repo.git',
        ].join('\n'),
      );

      await maybeStartAutoSyncFromEnv({ setIntervalFn, runOnce, stderr });
      scheduled?.();

      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(stderr.write).toHaveBeenCalledWith(
        '[auto-sync] Previous run is still active; skipping overlapping run.\n',
      );

      releaseRun?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      scheduled?.();

      expect(runOnce).toHaveBeenCalledTimes(2);
    } finally {
      if (previousFlag === undefined) delete process.env.AUTO_UPDATE_AND_ANALYZE_FLAG;
      else process.env.AUTO_UPDATE_AND_ANALYZE_FLAG = previousFlag;
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
