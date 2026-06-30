import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getGlobalDir } from '../../storage/repo-manager.js';
import { normalizeConfiguredCloneRoot } from './path-security.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

export const AUTO_SYNC_FLAG = 'AUTO_UPDATE_AND_ANALYZE_FLAG';
export const AUTO_SYNC_CONFIG_FILE = 'sync_config.yml';
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MIN_SYNC_INTERVAL_MINUTES = 5;

export interface AutoSyncProjectConfig {
  localPath: string;
  gitnexusGroup?: string;
  branches: string[];
  remoteUrls: string[];
}

export interface AutoSyncConfig {
  configPath: string;
  syncIntervalMinutes: number;
  projects: AutoSyncProjectConfig[];
}

export type AutoSyncFlagDecision =
  | { enabled: true }
  | { enabled: false; reason: 'unset' | 'disabled' | 'invalid'; message?: string };

export type AutoSyncConfigLoadResult =
  | { ok: true; config: AutoSyncConfig }
  | { ok: false; reason: 'missing' | 'unreadable' | 'invalid'; message: string };

export function parseAutoSyncFlag(raw = process.env[AUTO_SYNC_FLAG]): AutoSyncFlagDecision {
  if (raw === undefined || raw.trim() === '') return { enabled: false, reason: 'unset' };
  const trimmed = raw.trim();
  if (trimmed === '0') return { enabled: false, reason: 'disabled' };
  if (trimmed === '1') return { enabled: true };
  return {
    enabled: false,
    reason: 'invalid',
    message: `[auto-sync] ${AUTO_SYNC_FLAG} must be 0 or 1; got "${trimmed}". Auto sync is disabled.`,
  };
}

export function getAutoSyncConfigPath(gitnexusDir = getGlobalDir()): string {
  return path.join(gitnexusDir, AUTO_SYNC_CONFIG_FILE);
}

export function parseBranchCandidates(branchValue: unknown): string[] {
  const rawItems = Array.isArray(branchValue)
    ? branchValue.flatMap((item) => String(item).split(','))
    : String(branchValue ?? '').split(',');
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const branch = item.trim();
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    branches.push(branch);
  }
  return branches;
}

export async function loadAutoSyncConfig(
  configPath = getAutoSyncConfigPath(),
): Promise<AutoSyncConfigLoadResult> {
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'missing',
        message: `[auto-sync] Missing config file: ${configPath}. Auto sync is skipped.`,
      };
    }
    return {
      ok: false,
      reason: 'unreadable',
      message: `[auto-sync] Unable to read config file: ${configPath}. Auto sync is skipped.`,
    };
  }

  try {
    return { ok: true, config: parseAutoSyncConfig(content, configPath) };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: 'invalid',
      message: `[auto-sync] Invalid sync_config.yml: ${(err as Error).message}. Auto sync is skipped.`,
    };
  }
}

export function parseAutoSyncConfig(content: string, configPath: string): AutoSyncConfig {
  const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('expected a YAML object');
  }

  const errors: string[] = [];
  const interval = Number(raw.sync_interval_minutes);
  if (!Number.isInteger(interval) || interval <= 0) {
    errors.push('sync_interval_minutes must be a positive integer');
  } else if (interval < MIN_SYNC_INTERVAL_MINUTES) {
    errors.push(`sync_interval_minutes must be at least ${MIN_SYNC_INTERVAL_MINUTES}`);
  }

  const rawProjects = raw.projects;
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    errors.push('projects must contain at least one project');
  }

  const projects: AutoSyncProjectConfig[] = [];
  if (Array.isArray(rawProjects)) {
    rawProjects.forEach((projectValue, index) => {
      const project = projectValue as Record<string, unknown>;
      if (!project || typeof project !== 'object' || Array.isArray(project)) {
        errors.push(`projects[${index}] must be an object`);
        return;
      }

      const localPath = typeof project.local_path === 'string' ? project.local_path.trim() : '';
      if (!localPath) {
        errors.push(`projects[${index}].local_path is required`);
      } else {
        try {
          normalizeConfiguredCloneRoot(localPath);
        } catch (err: unknown) {
          errors.push(`projects[${index}].local_path ${(err as Error).message}`);
        }
      }

      const remoteUrls = Array.isArray(project.remote_urls)
        ? project.remote_urls.map((url) => String(url).trim()).filter(Boolean)
        : [];
      if (remoteUrls.length === 0) {
        errors.push(`projects[${index}].remote_urls must contain at least one URL`);
      }

      const branches = parseBranchCandidates(project.branch);
      if (branches.length === 0) errors.push(`projects[${index}].branch is required`);

      const gitnexusGroup =
        typeof project.gitnexus_group === 'string' ? project.gitnexus_group.trim() : undefined;
      if (gitnexusGroup && !GROUP_NAME_PATTERN.test(gitnexusGroup)) {
        errors.push(`projects[${index}].gitnexus_group is invalid`);
      }

      if (localPath && remoteUrls.length > 0 && branches.length > 0) {
        projects.push({ localPath, gitnexusGroup, branches, remoteUrls });
      }
    });
  }

  if (errors.length > 0) throw new Error(errors.join('; '));
  return { configPath, syncIntervalMinutes: interval, projects };
}
