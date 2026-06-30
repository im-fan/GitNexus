import { loadAutoSyncConfig, parseAutoSyncFlag } from './config.js';
import { runAutoSyncOnce } from './runner.js';

export interface AutoSyncStartHandle {
  stop(): void;
}

export async function maybeStartAutoSyncFromEnv(options: {
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  runOnce?: typeof runAutoSyncOnce;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
} = {}): Promise<AutoSyncStartHandle | null> {
  const stderr = options.stderr ?? process.stderr;
  const flag = parseAutoSyncFlag();
  if (flag.enabled === false) {
    if (flag.message) stderr.write(`${flag.message}\n`);
    return null;
  }

  const loaded = await loadAutoSyncConfig();
  if (loaded.ok === false) {
    stderr.write(`${loaded.message}\n`);
    return null;
  }

  const runOnce = options.runOnce ?? runAutoSyncOnce;
  let running = false;
  const runSafely = () => {
    if (running) {
      stderr.write('[auto-sync] Previous run is still active; skipping overlapping run.\n');
      return;
    }
    running = true;
    void runOnce(loaded.config)
      .catch((err: unknown) => {
        stderr.write(`[auto-sync] Scheduled run failed: ${(err as Error).message}\n`);
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
  timer.unref?.();
  return { stop: () => clearIntervalFn(timer) };
}
