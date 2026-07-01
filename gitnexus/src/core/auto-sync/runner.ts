import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadGroupConfig } from '../group/config-parser.js';
import { getDefaultGitnexusDir, getGroupDir } from '../group/storage.js';
import { syncGroup } from '../group/sync.js';
import { runFullAnalysis } from '../run-analyze.js';
import { getCurrentBranch, getCurrentCommit } from '../../storage/git.js';
import { registerRepo, type RepoMeta } from '../../storage/repo-manager.js';
import { extractRepoNameFromRemoteUrl } from './repo.js';
import { cloneOrPull } from '../../server/git-clone.js';
import { resolveConfiguredCloneRoot } from './path-security.js';
import {
  buildStateKey,
  loadAutoSyncState,
  saveAutoSyncState,
  shouldAnalyzeCommit,
  writeProjectCommitInfo,
  type AutoSyncAnalyzeStatus,
  type AutoSyncCommitStateEntry,
  type ProjectCommitInfoEntry,
} from './state.js';
import type { AutoSyncConfig, AutoSyncProjectConfig } from './config.js';
import { validateAutoSyncRemoteUrl } from './config.js';

export interface AutoSyncLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AutoSyncRunDeps {
  cloneOrPull: typeof cloneOrPull;
  getCurrentBranch: typeof getCurrentBranch;
  getCurrentCommit: typeof getCurrentCommit;
  runFullAnalysis: typeof runFullAnalysis;
  registerRepo: typeof registerRepo;
  loadState: typeof loadAutoSyncState;
  saveState: typeof saveAutoSyncState;
  writeCommitInfo: typeof writeProjectCommitInfo;
  addRepoToGroup: typeof addRepoToGroup;
  syncGroupByName: typeof syncGroupByName;
  resolveCloneRoot: typeof resolveConfiguredCloneRoot;
  getAvailableMemoryGB: () => number;
}

export interface AutoSyncRunResult {
  synced: number;
  analyzed: number;
  skippedAnalysis: number;
  failed: number;
}

const DEFAULT_LOGGER: AutoSyncLogger = {
  info: (message) => process.stderr.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

const DEFAULT_DEPS: AutoSyncRunDeps = {
  cloneOrPull,
  getCurrentBranch,
  getCurrentCommit,
  runFullAnalysis,
  registerRepo,
  loadState: loadAutoSyncState,
  saveState: saveAutoSyncState,
  writeCommitInfo: writeProjectCommitInfo,
  addRepoToGroup,
  syncGroupByName,
  resolveCloneRoot: resolveConfiguredCloneRoot,
  getAvailableMemoryGB: () => Math.floor(process.availableMemory?.() ?? 0) / 1024 / 1024 / 1024,
};

export async function runAutoSyncOnce(
  config: AutoSyncConfig,
  options: { deps?: Partial<AutoSyncRunDeps>; logger?: AutoSyncLogger; now?: () => Date } = {},
): Promise<AutoSyncRunResult> {
  const deps = { ...DEFAULT_DEPS, ...options.deps };
  const logger = options.logger ?? DEFAULT_LOGGER;
  const now = options.now ?? (() => new Date());
  const state = await deps.loadState();
  const groupsToSync = new Set<string>();
  const result: AutoSyncRunResult = { synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 };
  const commitInfoEntries: ProjectCommitInfoEntry[] = [];
  const actualConcurrency = resolveActualConcurrency(config.maxConcurrency, deps.getAvailableMemoryGB());
  logger.info(
    `[auto-sync] Starting sync loop with max_concurrency=${actualConcurrency} analyze_failure_threshold=${config.analyzeFailureThreshold}.`,
  );

  const workItems = await buildWorkItems(config, deps);
  const repoResults = await mapWithConcurrency(workItems, actualConcurrency, async (item) => {
    const lastSyncTime = now().toISOString();
    try {
      validateAutoSyncRemoteUrl(item.remoteUrl);
      const repoName = extractRepoNameFromRemoteUrl(item.remoteUrl);
      const targetDir = getConfiguredRepoPath({ localPath: item.cloneRoot.root }, repoName);
      const syncResult = await syncFirstAvailableBranch({
        item,
        repoName,
        targetDir,
        timeoutMs: config.repoGitTimeoutMs,
        deps,
        logger,
      });
      if (syncResult.ok === false) {
        logger.error(
          `[auto-sync] Repository sync failed for ${item.remoteUrl}; no configured branch could be pulled: ${syncResult.message}`,
        );
        return {
          kind: 'failed' as const,
          project: item.project,
          remoteUrl: item.remoteUrl,
          targetDir,
          branch: item.project.branches[0],
          status: syncResult.status,
          analyzeConsecutiveFailures: 0,
          lastSyncTime,
        };
      }

      const currentBranch = syncResult.branch;

      const currentCommit = deps.getCurrentCommit(targetDir);
      const stateKey = buildStateKey(targetDir, currentBranch);
      const previous = state[stateKey];
      let analyzeStatus: AutoSyncAnalyzeStatus = 'skipped';
      let analyzedCommitId = previous?.analyzedCommitId;
      let analyzeConsecutiveFailures = previous?.analyzeConsecutiveFailures ?? 0;
      let lastAnalyzeError = previous?.lastAnalyzeError;
      let stats: RepoMeta['stats'] | undefined;

      if (analyzeConsecutiveFailures >= config.analyzeFailureThreshold) {
        analyzeStatus = 'threshold_skipped';
        logger.error(
          `[auto-sync] Skip analysis for ${targetDir}; analyze consecutive failures ${analyzeConsecutiveFailures}/${config.analyzeFailureThreshold} reached threshold. Fix the repository or clear auto-sync state before retrying.`,
        );
      } else if (
        shouldAnalyzeCommit({
          currentCommit,
          previousAnalyzedCommit: previous?.analyzedCommitId,
          previousStatus: previous?.lastAnalyzeStatus,
        })
      ) {
        try {
          const analysis = await deps.runFullAnalysis(
            targetDir,
            { branch: currentBranch, skipAgentsMd: true, skipSkills: true },
            { onProgress: () => {} },
          );
          stats = analysis.stats;
          analyzeStatus = 'success';
          analyzedCommitId = currentCommit;
          analyzeConsecutiveFailures = 0;
          lastAnalyzeError = undefined;
        } catch (err: unknown) {
          analyzeStatus = 'failed';
          analyzeConsecutiveFailures += 1;
          lastAnalyzeError = shortErrorMessage(err);
          logger.error(
            `[auto-sync] Analysis failed for ${targetDir}; consecutive failures ${analyzeConsecutiveFailures}/${config.analyzeFailureThreshold}: ${lastAnalyzeError}`,
          );
        }
      } else {
        logger.info(`[auto-sync] Skip analysis for ${targetDir}; commit unchanged.`);
      }

      return {
        kind: 'synced' as const,
        project: item.project,
        repoName,
        remoteUrl: item.remoteUrl,
        targetDir,
        branch: currentBranch,
        currentCommit,
        analyzedCommitId,
        analyzeStatus,
        analyzeConsecutiveFailures,
        lastAnalyzeError,
        stats,
        stateKey,
        lastSyncTime,
      };
    } catch (err: unknown) {
      logger.error(`[auto-sync] Repository sync failed for ${item.remoteUrl}: ${(err as Error).message}`);
      return {
        kind: 'failed' as const,
        project: item.project,
        remoteUrl: item.remoteUrl,
        targetDir: '',
        status: 'sync_failed' as const,
        lastSyncTime,
      };
    }
  });

  for (const repoResult of repoResults) {
    if (repoResult.kind === 'failed') {
      result.failed += 1;
      commitInfoEntries.push({
        remoteUrl: repoResult.remoteUrl,
        localPath: repoResult.targetDir,
        branch: repoResult.branch,
        status: repoResult.status,
        lastSyncTime: repoResult.lastSyncTime,
      });
      continue;
    }

    result.synced += 1;
    const stateEntry: AutoSyncCommitStateEntry = {
      codeCommitId: repoResult.currentCommit,
      analyzedCommitId: repoResult.analyzedCommitId,
      lastAnalyzeStatus: repoResult.analyzeStatus,
      analyzeConsecutiveFailures: repoResult.analyzeConsecutiveFailures,
      lastAnalyzeError: repoResult.lastAnalyzeError,
      lastSyncTime: repoResult.lastSyncTime,
    };
    state[repoResult.stateKey] = stateEntry;
    if (repoResult.analyzeStatus === 'success') {
      const meta: RepoMeta = {
        repoPath: repoResult.targetDir,
        lastCommit: repoResult.currentCommit,
        indexedAt: repoResult.lastSyncTime,
        stats: repoResult.stats!,
        branch: repoResult.branch,
      };
      await deps.registerRepo(repoResult.targetDir, meta, {
        name: repoResult.repoName,
        allowDuplicateName: true,
      });
      result.analyzed += 1;
    } else if (repoResult.analyzeStatus === 'failed') {
      result.failed += 1;
    } else if (repoResult.analyzeStatus === 'threshold_skipped') {
      result.skippedAnalysis += 1;
    } else {
      result.skippedAnalysis += 1;
    }

    commitInfoEntries.push({
      remoteUrl: repoResult.remoteUrl,
      localPath: repoResult.targetDir,
      branch: repoResult.branch,
      codeCommitId: repoResult.currentCommit,
      analyzedCommitId: repoResult.analyzedCommitId,
      status: repoResult.analyzeStatus,
      analyzeConsecutiveFailures: repoResult.analyzeConsecutiveFailures,
      analyzeFailureThreshold: config.analyzeFailureThreshold,
      lastAnalyzeError: repoResult.lastAnalyzeError,
      lastSyncTime: repoResult.lastSyncTime,
    });

    if (repoResult.project.groupName) {
      let groupMembershipOk = false;
      try {
        await deps.addRepoToGroup(repoResult.project, repoResult.repoName);
        groupMembershipOk = true;
      } catch (err: unknown) {
        result.failed += 1;
        logger.error(`[auto-sync] Group update failed for ${repoResult.project.groupName}: ${(err as Error).message}`);
      }
      if (groupMembershipOk && repoResult.analyzeStatus === 'success') {
        groupsToSync.add(repoResult.project.groupName);
      }
    }
  }

  await deps.saveState(state);
  await deps.writeCommitInfo(commitInfoEntries);
  for (const groupName of groupsToSync) {
    try {
      await deps.syncGroupByName(groupName);
    } catch (err: unknown) {
      result.failed += 1;
      logger.error(`[auto-sync] Group sync failed for ${groupName}: ${(err as Error).message}`);
    }
  }
  return result;
}

function shortErrorMessage(err: unknown): string {
  const message = (err as Error).message || String(err);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

export function getConfiguredRepoPath(
  project: Pick<AutoSyncProjectConfig, 'localPath'>,
  repoName: string,
): string {
  return path.resolve(project.localPath, repoName);
}

export async function addRepoToGroup(
  project: Pick<AutoSyncProjectConfig, 'groupName'>,
  repoName: string,
): Promise<boolean> {
  if (!project.groupName) return false;
  const groupDir = getGroupDir(getDefaultGitnexusDir(), project.groupName);
  const config = await loadGroupConfig(groupDir);
  if (Object.values(config.repos).includes(repoName)) return false;
  config.repos[repoName] = repoName;
  await writeGroupConfigAtomic(path.join(groupDir, 'group.yaml'), config);
  return true;
}

export async function syncGroupByName(groupName: string): Promise<void> {
  const groupDir = getGroupDir(getDefaultGitnexusDir(), groupName);
  const config = await loadGroupConfig(groupDir);
  await syncGroup(config, { groupDir, allowStale: true });
}

async function writeGroupConfigAtomic(filePath: string, config: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, yaml.dump(config), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function resolveActualConcurrency(configured: number, availableMemoryGB: number): number {
  const memoryLimit = Math.max(1, Math.floor(availableMemoryGB / 2));
  return Math.max(1, Math.min(configured, memoryLimit));
}

async function buildWorkItems(config: AutoSyncConfig, deps: AutoSyncRunDeps): Promise<AutoSyncWorkItem[]> {
  const items: AutoSyncWorkItem[] = [];
  const targetOwners = new Map<string, string>();
  for (const project of config.projects) {
    const cloneRoot = await deps.resolveCloneRoot(project.localPath);
    for (const remoteUrl of project.remoteUrls) {
      try {
        const repoName = extractRepoNameFromRemoteUrl(remoteUrl);
        const targetDir = getConfiguredRepoPath({ localPath: cloneRoot.root }, repoName);
        const previous = targetOwners.get(targetDir);
        if (previous !== undefined) {
          throw new Error(`Duplicate auto-sync targetDir ${targetDir} for ${previous} and ${remoteUrl}`);
        }
        targetOwners.set(targetDir, remoteUrl);
      } catch (err: unknown) {
        if ((err as Error).message.startsWith('Duplicate auto-sync targetDir')) throw err;
      }
      items.push({ project, remoteUrl, cloneRoot });
    }
  }
  return items;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });
  await Promise.all(runners);
  return results;
}

interface AutoSyncWorkItem {
  project: AutoSyncProjectConfig;
  remoteUrl: string;
  cloneRoot: Awaited<ReturnType<typeof resolveConfiguredCloneRoot>>;
}

async function syncFirstAvailableBranch(input: {
  item: AutoSyncWorkItem;
  repoName: string;
  targetDir: string;
  timeoutMs: number;
  deps: AutoSyncRunDeps;
  logger: AutoSyncLogger;
}): Promise<
  | { ok: true; branch: string }
  | { ok: false; status: 'branch_unavailable' | 'sync_timeout'; message: string }
> {
  const failures: string[] = [];
  let sawTimeout = false;
  for (const branch of input.item.project.branches) {
    try {
      await input.deps.cloneOrPull(input.item.remoteUrl, input.targetDir, undefined, {
        allowedCloneRoot: input.item.cloneRoot.root,
        expectedRepoName: input.repoName,
        quarantineRoot: input.item.cloneRoot.quarantineRoot,
        allowAutoSyncSsh: true,
        timeoutMs: input.timeoutMs,
        branch,
      });
      const currentBranch = input.deps.getCurrentBranch(input.targetDir);
      if (currentBranch === branch) return { ok: true, branch };
      failures.push(`${branch}: checked out ${currentBranch ?? '<detached>'}`);
      input.logger.warn(
        `[auto-sync] Branch ${branch} for ${input.item.remoteUrl} synced but current branch is ${currentBranch ?? '<detached>'}; trying next branch.`,
      );
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message.includes('timed out')) sawTimeout = true;
      failures.push(`${branch}: ${message}`);
      input.logger.warn(
        `[auto-sync] Branch ${branch} unavailable for ${input.item.remoteUrl}: ${message}`,
      );
    }
  }
  return {
    ok: false,
    status: sawTimeout ? 'sync_timeout' : 'branch_unavailable',
    message: failures.join('; '),
  };
}
