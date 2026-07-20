import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnalyzeOptions, AnalyzeResult } from '../run-analyze.js';
import type { WorkerMessage } from '../../server/analyze-worker.js';

const _require = createRequire(import.meta.url);
const TERMINATION_GRACE_MS = 10_000;

export type AutoSyncAnalysisRunner = (
  repoPath: string,
  options: AnalyzeOptions,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Pick<AnalyzeResult, 'stats'>>;

interface AnalysisWorker extends Pick<ChildProcess, 'send' | 'kill' | 'on'> {}

export interface AutoSyncAnalysisLaunchDeps {
  forkWorker: (workerPath: string, execArgv: string[]) => AnalysisWorker;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
}

const DEFAULT_DEPS: AutoSyncAnalysisLaunchDeps = {
  forkWorker: (workerPath, execArgv) =>
    fork(workerPath, [], {
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }),
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
};

export function createAutoSyncAnalysisRunner(
  overrides: Partial<AutoSyncAnalysisLaunchDeps> = {},
): AutoSyncAnalysisRunner {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return (repoPath, options, timeoutMs, signal) =>
    new Promise<Pick<AnalyzeResult, 'stats'>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Analysis cancelled.'));
        return;
      }
      const callerPath = fileURLToPath(import.meta.url);
      const isDev = callerPath.endsWith('.ts');
      const workerPath = path.join(
        path.dirname(callerPath),
        '../../server',
        isDev ? 'analyze-worker.ts' : 'analyze-worker.js',
      );
      if (!existsSync(workerPath)) {
        reject(new Error(`Auto-sync analyze worker is missing: ${workerPath}`));
        return;
      }
      const execArgv = isDev
        ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href, '--max-old-space-size=8192']
        : ['--max-old-space-size=8192'];
      const child = deps.forkWorker(workerPath, execArgv);
      let outcome: WorkerMessage | undefined;
      let timedOut = false;
      let cancelled = false;
      let terminationGrace: ReturnType<typeof setTimeout> | undefined;
      const timeout = deps.setTimeoutFn(() => {
        timedOut = true;
        child.kill('SIGTERM');
        terminationGrace = deps.setTimeoutFn(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
      }, timeoutMs);
      const onAbort = () => {
        cancelled = true;
        deps.clearTimeoutFn(timeout);
        if (terminationGrace) deps.clearTimeoutFn(terminationGrace);
        child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('message', (message: WorkerMessage) => {
        if (message.type !== 'progress') outcome ??= message;
        else outcome = message;
      });
      child.on('error', (error) => {
        outcome = { type: 'error', message: `Auto-sync analyze worker error: ${error.message}` };
      });
      child.on('exit', (code, childSignal) => {
        deps.clearTimeoutFn(timeout);
        if (terminationGrace) deps.clearTimeoutFn(terminationGrace);
        signal?.removeEventListener('abort', onAbort);
        if (cancelled) {
          reject(new Error('Analysis cancelled.'));
          return;
        }
        if (timedOut) {
          reject(
            new Error(
              `Analysis timed out after ${timeoutMs}ms and worker exited (${childSignal ?? code ?? 'unknown'}).`,
            ),
          );
          return;
        }
        if (outcome?.type === 'complete') {
          resolve({ stats: outcome.result.stats });
          return;
        }
        if (outcome?.type === 'error') {
          reject(new Error(outcome.message));
          return;
        }
        reject(
          new Error(
            `Auto-sync analyze worker exited before completion (${signal ?? code ?? 'unknown'}).`,
          ),
        );
      });
      child.send({ type: 'start', repoPath, options });
    });
}

export const runAutoSyncAnalysis = createAutoSyncAnalysisRunner();
