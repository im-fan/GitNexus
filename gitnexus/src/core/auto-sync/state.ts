import fs from 'node:fs/promises';
import path from 'node:path';
import { getGlobalDir } from '../../storage/repo-manager.js';

export type AutoSyncAnalyzeStatus = 'success' | 'failed' | 'skipped';

export interface AutoSyncCommitStateEntry {
  codeCommitId: string;
  analyzedCommitId?: string;
  lastAnalyzeStatus?: AutoSyncAnalyzeStatus;
  lastSyncTime: string;
}

export type AutoSyncCommitState = Record<string, AutoSyncCommitStateEntry>;

export function getAutoSyncStatePath(gitnexusDir = getGlobalDir()): string {
  return path.join(gitnexusDir, 'auto-sync-state.json');
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
