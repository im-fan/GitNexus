import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { getGlobalDir } from '../../storage/repo-manager.js';
import { loadAutoSyncConfig } from './config.js';
import { runAutoSyncOnce } from './runner.js';
import { getAutoSyncWatchDir } from './state.js';

export interface AutoSyncStartHandle {
  stop(): Promise<void>;
}

export type WatchStatusState = 'running' | 'stopping' | 'stopped' | 'stale' | 'error';

export interface WatchStatusRecord {
  state: WatchStatusState;
  pid?: number;
  ownerId?: string;
  configPath?: string;
  message?: string;
  updatedAt: string;
}

export interface WatchLockRecord {
  pid: number;
  ownerId: string;
  createdAt: string;
}

export interface AutoSyncWatchPaths {
  pidPath: string;
  lockPath: string;
  statusPath: string;
}

export interface AutoSyncWatchControlDeps {
  isProcessAlive(pid: number): boolean;
  killProcess(pid: number, signal?: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

export function getAutoSyncWatchPaths(gitnexusDir = getGlobalDir()): AutoSyncWatchPaths {
  const watchDir = getAutoSyncWatchDir(gitnexusDir);
  return {
    pidPath: path.join(watchDir, 'watch.pid'),
    lockPath: path.join(watchDir, 'watch.lock'),
    statusPath: path.join(watchDir, 'watch.status.json'),
  };
}

export async function startAutoSyncWatch(
  options: {
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    runOnce?: typeof runAutoSyncOnce;
    stderr?: Pick<NodeJS.WriteStream, 'write'>;
    keepAlive?: boolean;
    paths?: AutoSyncWatchPaths;
    deps?: Partial<AutoSyncWatchControlDeps>;
  } = {},
): Promise<AutoSyncStartHandle | null> {
  const stderr = options.stderr ?? process.stderr;
  const paths = options.paths ?? getAutoSyncWatchPaths();
  const deps = resolveWatchDeps(options.deps);
  const ownerId = crypto.randomUUID();
  await fs.mkdir(path.dirname(paths.pidPath), { recursive: true });
  const lockHandle = await acquireWatchLock(paths, deps, stderr);
  if (!lockHandle) return null;
  await lockHandle.writeFile(
    `${JSON.stringify({ pid: process.pid, ownerId, createdAt: new Date().toISOString() })}\n`,
    'utf-8',
  );
  await fs.writeFile(paths.pidPath, `${process.pid}\n`, 'utf-8');

  const loaded = await loadAutoSyncConfig();
  if (loaded.ok === false) {
    stderr.write(`${loaded.message}\n`);
    await writeWatchStatus(paths, {
      state: 'error',
      pid: process.pid,
      ownerId,
      message: loaded.message,
      updatedAt: new Date().toISOString(),
    });
    await cleanupWatchFiles(paths, lockHandle);
    return null;
  }
  await writeWatchStatus(paths, {
    state: 'running',
    pid: process.pid,
    ownerId,
    configPath: loaded.config.configPath,
    updatedAt: new Date().toISOString(),
  });

  const runOnce = options.runOnce ?? runAutoSyncOnce;
  let running = false;
  const runSafely = () => {
    if (running) {
      stderr.write('[auto-sync] Previous run is still active; skipping overlapping run.\n');
      return;
    }
    running = true;
    const startedAt = new Date();
    stderr.write(`[auto-sync] Watch loop started at ${startedAt.toISOString()}.\n`);
    void runOnce(loaded.config)
      .then((result) => {
        stderr.write(
          `[auto-sync] Watch loop finished: synced=${result.synced} analyzed=${result.analyzed} skipped=${result.skippedAnalysis} failed=${result.failed}.\n`,
        );
      })
      .catch((err: unknown) => {
        stderr.write(`[auto-sync] Scheduled run failed: ${(err as Error).message}\n`);
        stderr.write('[auto-sync] Watch loop finished: failed.\n');
      })
      .finally(() => {
        running = false;
      });
  };

  runSafely();
  const intervalMs = loaded.config.syncIntervalMinutes * 60_000;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const timer = setIntervalFn(runSafely, intervalMs);
  if (options.keepAlive === false) timer.unref?.();
  return {
    stop: async () => {
      clearIntervalFn(timer);
      await writeWatchStatus(paths, {
        state: 'stopped',
        pid: process.pid,
        ownerId,
        configPath: loaded.config.configPath,
        updatedAt: new Date().toISOString(),
      }).finally(() => cleanupWatchFiles(paths, lockHandle));
    },
  };
}

async function acquireWatchLock(
  paths: AutoSyncWatchPaths,
  deps: AutoSyncWatchControlDeps,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
): Promise<fs.FileHandle | null> {
  try {
    return await fs.open(paths.lockPath, 'wx');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const lock = await readLockFile(paths.lockPath);
  if (!lock) {
    const message = 'watch lock already exists but has no readable owner; refusing to start';
    stderr.write(`[auto-sync] ${message}.\n`);
    await writeWatchStatus(paths, {
      state: 'error',
      message,
      updatedAt: new Date().toISOString(),
    });
    return null;
  }

  if (deps.isProcessAlive(lock.pid)) {
    stderr.write(`[auto-sync] Watch is already running with pid ${lock.pid}.\n`);
    await writeWatchStatus(paths, {
      state: 'running',
      pid: lock.pid,
      ownerId: lock.ownerId,
      message: 'watch already running',
      updatedAt: new Date().toISOString(),
    });
    return null;
  }

  stderr.write(`[auto-sync] Removing stale watch lock for pid ${lock.pid}.\n`);
  await removeIfExists(paths.pidPath);
  await removeIfExists(paths.lockPath);
  await writeWatchStatus(paths, {
    state: 'stale',
    pid: lock.pid,
    ownerId: lock.ownerId,
    message: 'removed stale lock and pid',
    updatedAt: new Date().toISOString(),
  });

  try {
    return await fs.open(paths.lockPath, 'wx');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const message = 'watch lock was reacquired by another process; refusing to start';
      stderr.write(`[auto-sync] ${message}.\n`);
      await writeWatchStatus(paths, {
        state: 'error',
        message,
        updatedAt: new Date().toISOString(),
      });
      return null;
    }
    throw err;
  }
}

export async function stopAutoSyncWatch(
  options: {
    paths?: AutoSyncWatchPaths;
    stderr?: Pick<NodeJS.WriteStream, 'write'>;
    deps?: Partial<AutoSyncWatchControlDeps>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<boolean> {
  const stderr = options.stderr ?? process.stderr;
  const paths = options.paths ?? getAutoSyncWatchPaths();
  const deps = resolveWatchDeps(options.deps);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const pid = await readPid(paths.pidPath);
  if (!pid) {
    const lock = await readLockFile(paths.lockPath);
    if (lock && deps.isProcessAlive(lock.pid)) {
      const message = `watch appears to be starting with pid ${lock.pid}; pid file is not ready`;
      stderr.write(`[auto-sync] ${message}.\n`);
      await writeWatchStatus(paths, {
        state: 'error',
        pid: lock.pid,
        ownerId: lock.ownerId,
        message,
        updatedAt: new Date().toISOString(),
      });
      return false;
    }
    if (lock) {
      stderr.write(`[auto-sync] Removing stale watch lock for pid ${lock.pid}.\n`);
      await removeIfExists(paths.lockPath);
      await writeWatchStatus(paths, {
        state: 'stale',
        pid: lock.pid,
        ownerId: lock.ownerId,
        message: 'removed stale lock without pid file',
        updatedAt: new Date().toISOString(),
      });
      return false;
    }
    if (await fileExists(paths.lockPath)) {
      const message = 'watch lock exists but has no readable owner; refusing to stop';
      stderr.write(`[auto-sync] ${message}.\n`);
      await writeWatchStatus(paths, {
        state: 'error',
        message,
        updatedAt: new Date().toISOString(),
      });
      return false;
    }
    stderr.write('[auto-sync] Watch is not running.\n');
    await writeWatchStatus(paths, {
      state: 'stopped',
      message: 'no pid file',
      updatedAt: new Date().toISOString(),
    });
    return false;
  }
  if (!deps.isProcessAlive(pid)) {
    stderr.write(`[auto-sync] Removing stale watch pid ${pid}.\n`);
    await removeIfExists(paths.pidPath);
    await removeIfExists(paths.lockPath);
    await writeWatchStatus(paths, {
      state: 'stale',
      pid,
      message: 'removed stale pid and lock',
      updatedAt: new Date().toISOString(),
    });
    return false;
  }
  const owner = await readVerifiedWatchOwner(paths, pid);
  if (owner.ok === false) {
    const message = `refusing to stop pid ${pid}; ${owner.reason}`;
    stderr.write(`[auto-sync] ${message}.\n`);
    await writeWatchStatus(paths, {
      state: 'error',
      pid,
      message,
      updatedAt: new Date().toISOString(),
    });
    return false;
  }
  await writeWatchStatus(paths, {
    state: 'stopping',
    pid,
    ownerId: owner.owner.ownerId,
    message: 'stop signal sent; waiting for watch process to exit',
    updatedAt: new Date().toISOString(),
  });
  deps.killProcess(pid, 'SIGTERM');
  stderr.write(`[auto-sync] Stop signal sent to watch pid ${pid}.\n`);
  const stopped = await waitForProcessExit(pid, { deps, timeoutMs, pollMs });
  if (!stopped) {
    const message = `watch pid ${pid} did not exit within ${timeoutMs}ms`;
    stderr.write(`[auto-sync] ${message}.\n`);
    await writeWatchStatus(paths, {
      state: 'stopping',
      pid,
      ownerId: owner.owner.ownerId,
      message,
      updatedAt: new Date().toISOString(),
    });
    return false;
  }
  await removeIfExists(paths.pidPath);
  await removeIfExists(paths.lockPath);
  await writeWatchStatus(paths, {
    state: 'stopped',
    pid,
    ownerId: owner.owner.ownerId,
    message: 'watch stopped',
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function readAutoSyncWatchStatus(
  paths = getAutoSyncWatchPaths(),
  deps: Partial<AutoSyncWatchControlDeps> = {},
): Promise<WatchStatusRecord> {
  const resolvedDeps = resolveWatchDeps(deps);
  const pid = await readPid(paths.pidPath);
  if (pid && !resolvedDeps.isProcessAlive(pid)) {
    return {
      state: 'stale',
      pid,
      message: 'pid file exists but process is not running',
      updatedAt: new Date().toISOString(),
    };
  }
  if (pid) {
    const stored = await readStatusFile(paths.statusPath);
    const owner = await readVerifiedWatchOwner(paths, pid);
    if (owner.ok === false) {
      return {
        ...stored,
        state: 'error',
        pid,
        message: owner.reason,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...stored,
      state: stored?.state === 'stopping' ? 'stopping' : 'running',
      pid,
      ownerId: owner.owner.ownerId,
      updatedAt: new Date().toISOString(),
    };
  }
  const stored = await readStatusFile(paths.statusPath);
  return stored ?? { state: 'stopped', updatedAt: new Date().toISOString() };
}

async function readLockFile(lockPath: string): Promise<WatchLockRecord | undefined> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as WatchLockRecord;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId
    ) {
      return parsed;
    }
    return undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function readVerifiedWatchOwner(
  paths: AutoSyncWatchPaths,
  pid: number,
): Promise<{ ok: true; owner: WatchLockRecord } | { ok: false; reason: string }> {
  const [status, lock] = await Promise.all([
    readStatusFile(paths.statusPath),
    readLockFile(paths.lockPath),
  ]);
  if (!lock) return { ok: false, reason: 'watch lock is missing or invalid' };
  if (!status) return { ok: false, reason: 'watch status is missing or invalid' };
  if (lock.pid !== pid) return { ok: false, reason: 'watch lock pid does not match pid file' };
  if (status.pid !== pid) return { ok: false, reason: 'watch status pid does not match pid file' };
  if (!status.ownerId || status.ownerId !== lock.ownerId) {
    return { ok: false, reason: 'watch status owner does not match lock owner' };
  }
  return { ok: true, owner: lock };
}

async function waitForProcessExit(
  pid: number,
  options: { deps: AutoSyncWatchControlDeps; timeoutMs: number; pollMs: number },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (!options.deps.isProcessAlive(pid)) return true;
    await options.deps.sleep(options.pollMs);
  }
  return !options.deps.isProcessAlive(pid);
}

async function readPid(pidPath: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(pidPath, 'utf-8');
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readStatusFile(statusPath: string): Promise<WatchStatusRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as WatchStatusRecord;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      state: 'error',
      message: `unable to read status file: ${(err as Error).message}`,
      updatedAt: new Date().toISOString(),
    };
  }
}

async function writeWatchStatus(
  paths: AutoSyncWatchPaths,
  record: WatchStatusRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(paths.statusPath), { recursive: true });
  const tmpPath = `${paths.statusPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, paths.statusPath);
}

async function cleanupWatchFiles(
  paths: AutoSyncWatchPaths,
  lockHandle?: fs.FileHandle,
): Promise<void> {
  await lockHandle?.close().catch(() => {});
  await removeIfExists(paths.pidPath);
  await removeIfExists(paths.lockPath);
}

async function removeIfExists(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

function resolveWatchDeps(deps: Partial<AutoSyncWatchControlDeps> = {}): AutoSyncWatchControlDeps {
  return {
    isProcessAlive:
      deps.isProcessAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    killProcess:
      deps.killProcess ??
      ((pid, signal = 'SIGTERM') => {
        process.kill(pid, signal);
      }),
    sleep:
      deps.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        })),
  };
}
