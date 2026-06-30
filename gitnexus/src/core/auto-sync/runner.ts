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
  type AutoSyncAnalyzeStatus,
} from './state.js';
import type { AutoSyncConfig, AutoSyncProjectConfig } from './config.js';

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
  addRepoToGroup: typeof addRepoToGroup;
  syncGroupByName: typeof syncGroupByName;
  resolveCloneRoot: typeof resolveConfiguredCloneRoot;
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
  addRepoToGroup,
  syncGroupByName,
  resolveCloneRoot: resolveConfiguredCloneRoot,
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

  for (const project of config.projects) {
    for (const remoteUrl of project.remoteUrls) {
      try {
        const repoName = extractRepoNameFromRemoteUrl(remoteUrl);
        const cloneRoot = await deps.resolveCloneRoot(project.localPath);
        const targetDir = getConfiguredRepoPath({ localPath: cloneRoot.root }, repoName);
        await deps.cloneOrPull(remoteUrl, targetDir, undefined, {
          allowedCloneRoot: cloneRoot.root,
          expectedRepoName: repoName,
          quarantineRoot: cloneRoot.quarantineRoot,
        });
        result.synced += 1;

        const currentBranch = deps.getCurrentBranch(targetDir);
        if (!currentBranch || !project.branches.includes(currentBranch)) {
          result.skippedAnalysis += 1;
          logger.warn(
            `[auto-sync] Skip analysis for ${targetDir}; current branch ${currentBranch ?? '<detached>'} is not in configured branches: ${project.branches.join(', ')}.`,
          );
          continue;
        }

        const branch = currentBranch;
        const currentCommit = deps.getCurrentCommit(targetDir);
        const stateKey = buildStateKey(targetDir, branch);
        const previous = state[stateKey];
        let analyzeStatus: AutoSyncAnalyzeStatus = 'skipped';
        let analyzedCommitId = previous?.analyzedCommitId;

        if (
          shouldAnalyzeCommit({
            currentCommit,
            previousAnalyzedCommit: previous?.analyzedCommitId,
            previousStatus: previous?.lastAnalyzeStatus,
          })
        ) {
          try {
            const analysis = await deps.runFullAnalysis(
              targetDir,
              { branch, skipAgentsMd: true, skipSkills: true },
              { onProgress: () => {} },
            );
            const meta: RepoMeta = {
              repoPath: targetDir,
              lastCommit: currentCommit,
              indexedAt: now().toISOString(),
              stats: analysis.stats,
              branch,
            };
            await deps.registerRepo(targetDir, meta, { name: repoName, allowDuplicateName: true });
            analyzeStatus = 'success';
            analyzedCommitId = currentCommit;
            result.analyzed += 1;
          } catch (err: unknown) {
            analyzeStatus = 'failed';
            result.failed += 1;
            logger.error(`[auto-sync] Analysis failed for ${targetDir}: ${(err as Error).message}`);
          }
        } else {
          result.skippedAnalysis += 1;
          logger.info(`[auto-sync] Skip analysis for ${targetDir}; commit unchanged.`);
        }

        state[stateKey] = {
          codeCommitId: currentCommit,
          analyzedCommitId,
          lastAnalyzeStatus: analyzeStatus,
          lastSyncTime: now().toISOString(),
        };

        if (project.gitnexusGroup) {
          const added = await deps.addRepoToGroup(project, repoName);
          if (added) groupsToSync.add(project.gitnexusGroup);
        }
      } catch (err: unknown) {
        result.failed += 1;
        logger.error(`[auto-sync] Repository sync failed for ${remoteUrl}: ${(err as Error).message}`);
      }
    }
  }

  await deps.saveState(state);
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

export function getConfiguredRepoPath(
  project: Pick<AutoSyncProjectConfig, 'localPath'>,
  repoName: string,
): string {
  return path.resolve(project.localPath, repoName);
}

export async function addRepoToGroup(
  project: Pick<AutoSyncProjectConfig, 'gitnexusGroup'>,
  repoName: string,
): Promise<boolean> {
  if (!project.gitnexusGroup) return false;
  const groupDir = getGroupDir(getDefaultGitnexusDir(), project.gitnexusGroup);
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
