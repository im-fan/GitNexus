import fs from 'node:fs/promises';
import path from 'node:path';
import { getGlobalDir } from '../../storage/repo-manager.js';

export type AutoSyncAnalyzeStatus = 'success' | 'failed' | 'skipped' | 'threshold_skipped';

export interface AutoSyncCommitStateEntry {
  codeCommitId: string;
  analyzedCommitId?: string;
  lastAnalyzeStatus?: AutoSyncAnalyzeStatus;
  analyzeConsecutiveFailures?: number;
  lastAnalyzeError?: string;
  lastSyncTime: string;
}

export type AutoSyncCommitState = Record<string, AutoSyncCommitStateEntry>;

export function getAutoSyncWatchDir(gitnexusDir = getGlobalDir()): string {
  return path.join(gitnexusDir, 'watch');
}

export function getAutoSyncStatePath(gitnexusDir = getGlobalDir()): string {
  return path.join(getAutoSyncWatchDir(gitnexusDir), 'auto-sync-state.json');
}

export function getProjectCommitInfoPath(gitnexusDir = getGlobalDir()): string {
  return path.join(getAutoSyncWatchDir(gitnexusDir), 'project_commit_info.txt');
}

export function buildStateKey(repoPath: string, branch: string): string {
  return `${path.resolve(repoPath)}|${branch}`;
}

export function shouldAnalyzeCommit(input: {
  currentCommit: string;
  previousAnalyzedCommit?: string;
  previousStatus?: AutoSyncAnalyzeStatus;
}): boolean {
  if (!input.currentCommit) return false;
  if (input.previousStatus === 'failed') return true;
  return input.currentCommit !== input.previousAnalyzedCommit;
}

export async function loadAutoSyncState(
  statePath = getAutoSyncStatePath(),
): Promise<AutoSyncCommitState> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as AutoSyncCommitState)
      : {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[auto-sync] Ignoring unreadable or corrupt state file: ${statePath}. State will be rebuilt.\n`,
      );
    }
    return {};
  }
}

export async function saveAutoSyncState(
  state: AutoSyncCommitState,
  statePath = getAutoSyncStatePath(),
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, statePath);
}

export async function writeProjectCommitInfo(
  entries: ProjectCommitInfoEntry[],
  infoPath = getProjectCommitInfoPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(infoPath), { recursive: true });
  const lines = [
    '# GitNexus auto-sync project commit info',
    `updated_at: ${new Date().toISOString()}`,
    '',
    ...entries.flatMap((entry) => [
      `remote: ${entry.remoteUrl}`,
      `local_path: ${entry.localPath}`,
      `branch: ${entry.branch ?? ''}`,
      `code_commit: ${entry.codeCommitId ?? ''}`,
      `analyzed_commit: ${entry.analyzedCommitId ?? ''}`,
      `status: ${entry.status}`,
      `analyze_consecutive_failures: ${entry.analyzeConsecutiveFailures ?? 0}`,
      ...(entry.analyzeFailureThreshold === undefined
        ? []
        : [`analyze_failure_threshold: ${entry.analyzeFailureThreshold}`]),
      ...(entry.lastAnalyzeError ? [`last_analyze_error: ${entry.lastAnalyzeError}`] : []),
      `last_sync_time: ${entry.lastSyncTime}`,
      '',
    ]),
  ];
  const tmpPath = `${infoPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf-8');
  await fs.rename(tmpPath, infoPath);
}

export interface ProjectCommitInfoEntry {
  remoteUrl: string;
  localPath: string;
  branch?: string;
  codeCommitId?: string;
  analyzedCommitId?: string;
  status:
    | AutoSyncAnalyzeStatus
    | 'sync_failed'
    | 'branch_skipped'
    | 'branch_unavailable'
    | 'sync_timeout';
  analyzeConsecutiveFailures?: number;
  analyzeFailureThreshold?: number;
  lastAnalyzeError?: string;
  lastSyncTime: string;
}
