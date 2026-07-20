import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createAutoSyncAnalysisRunner } from '../../src/core/auto-sync/analysis-worker-launch.js';

describe('auto-sync analysis worker', () => {
  it('waits for timed-out worker exit before releasing the scheduled run', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
    });
    const timers: Array<() => void> = [];
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    expect(child.send).toHaveBeenCalledWith({
      type: 'start',
      repoPath: '/tmp/repo',
      options: { branch: 'main' },
    });

    timers[0]();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    timers[1]();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('exit', null, 'SIGKILL');
    await expect(result).rejects.toThrow('Analysis timed out after 50ms');
  });

  it('kills an active worker immediately when watch is stopped', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
    });
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
    });
    const controller = new AbortController();

    const result = run('/tmp/repo', { branch: 'main' }, 50, controller.signal);
    controller.abort();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await expect(result).rejects.toThrow('Analysis cancelled');
  });
});
