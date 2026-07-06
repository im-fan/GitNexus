import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAutoSyncConfigPath,
  readAutoSyncWatchStatus,
  startAutoSyncWatch,
  stopAutoSyncWatch,
  type WatchStatusRecord,
} from '../core/auto-sync/index.js';

export async function watchCommand(action = 'start'): Promise<void> {
  if (action === 'init') {
    await initWatchConfig();
    return;
  }
  if (action === 'status') {
    printStatus(await readAutoSyncWatchStatus());
    return;
  }
  if (action === 'stop') {
    await stopAutoSyncWatch();
    return;
  }
  if (action === 'restart') {
    const stopped = await stopAutoSyncWatch();
    if (!stopped) {
      process.exitCode = 1;
      return;
    }
    await startWatchProcess();
    return;
  }
  if (action !== 'start') {
    process.stderr.write(`[auto-sync] Unknown watch action: ${action}\n`);
    process.exitCode = 1;
    return;
  }
  await startWatchProcess();
}

async function startWatchProcess(): Promise<void> {
  const handle = await startAutoSyncWatch();
  if (!handle) {
    process.exitCode = 1;
    return;
  }

  const stop = () => {
    void handle.stop().finally(() => {
      process.stderr.write('[auto-sync] Watch stopped.\n');
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function printStatus(status: WatchStatusRecord): void {
  const parts = [`state=${status.state}`];
  if (status.pid) parts.push(`pid=${status.pid}`);
  if (status.configPath) parts.push(`config=${status.configPath}`);
  if (status.message) parts.push(`message=${status.message}`);
  parts.push(`updated_at=${status.updatedAt}`);
  process.stdout.write(`${parts.join(' ')}\n`);
}

async function initWatchConfig(): Promise<void> {
  const configPath = getAutoSyncConfigPath();
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      defaultSyncConfig(path.resolve(path.dirname(configPath), 'repo')),
      {
        flag: 'wx',
      },
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stderr.write(`[auto-sync] Config already exists: ${configPath}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  process.stdout.write(`[auto-sync] Created ${configPath}\n`);
}

function defaultSyncConfig(localPath: string): string {
  return [
    'sync_interval_minutes: 10',
    'max_concurrency: 1',
    'repo_git_timeout: 10s',
    'analyze_failure_threshold: 3',
    'projects:',
    `  - local_path: ${localPath}`,
    '    branches: [master, main]',
    '    group_name: back_end',
    '    remote_urls:',
    '      - git@github.com:owner/repo.git',
    '',
  ].join('\n');
}
