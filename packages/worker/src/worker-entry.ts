import { FluidSolver, type Obstacle } from '@tabby/physics';
import {
  HEADER_FLAGS,
  MAX_ABSORB_ZONES,
  type AbsorbZone,
  type MainToWorker,
  type WorkerScopeLike,
  type WorkerToMain,
} from './protocol.js';
import { SharedFluidBuffer } from './shared-buffer.js';

/**
 * Worker 侧入口。宿主（demo / 业务方）只需要一行：
 *
 * ```ts
 * // physics.worker.ts
 * import { startFluidWorker } from '@tabby/worker';
 * startFluidWorker(self as unknown as WorkerScopeLike);
 * ```
 *
 * 用自己的一行 worker 文件而不是包内直接 `new Worker(new URL(...))`，
 * 是为了让 Vite / webpack / Capacitor 各自用正确的打包规则处理 worker 入口，
 * 也让「半开源」的使用者能自己决定 worker 文件名与拆包策略。
 */
export function startFluidWorker(scope: WorkerScopeLike): void {
  let solver: FluidSolver | null = null;
  let shared: SharedFluidBuffer | null = null;
  let obstacles: readonly Obstacle[] = [];
  let zones: readonly AbsorbZone[] = [];
  let absorbedTotal = 0;
  const zoneCounts: number[] = new Array(MAX_ABSORB_ZONES).fill(0);

  const reply = (message: WorkerToMain, transfer?: Transferable[]): void => {
    if (transfer === undefined) scope.postMessage(message);
    else scope.postMessage(message, transfer);
  };

  const absorb = (): void => {
    if (solver === null || zones.length === 0) return;
    const positions = solver.positions;
    for (let z = 0; z < zones.length && z < MAX_ABSORB_ZONES; z += 1) {
      const zone = zones[z];
      if (zone === undefined) continue;
      for (let i = 0; i < solver.count; ) {
        const x = positions[i * 3] ?? 0;
        const y = positions[i * 3 + 1] ?? 0;
        const pz = positions[i * 3 + 2] ?? 0;
        if (
          x >= zone.min.x &&
          x <= zone.max.x &&
          y >= zone.min.y &&
          y <= zone.max.y &&
          pz >= zone.min.z &&
          pz <= zone.max.z
        ) {
          // despawn 是 swap-remove，需要同步修正输出缓冲里被交换过来的那个粒子
          const last = solver.count - 1;
          solver.despawn(i);
          if (i !== last) {
            positions[i * 3] = positions[last * 3] ?? 0;
            positions[i * 3 + 1] = positions[last * 3 + 1] ?? 0;
            positions[i * 3 + 2] = positions[last * 3 + 2] ?? 0;
          }
          zoneCounts[z] = (zoneCounts[z] ?? 0) + 1;
          absorbedTotal += 1;
        } else {
          i += 1;
        }
      }
    }
  };

  const handle = (message: MainToWorker): void => {
    switch (message.type) {
      case 'init': {
        solver = new FluidSolver(message.config.fluid, 1337);
        obstacles = message.config.obstacles;
        zones = message.config.zones;
        shared = message.shared === undefined ? null : new SharedFluidBuffer(message.shared);
        if (shared !== null) {
          Atomics.store(shared.header, HEADER_FLAGS, 1);
        }
        reply({ type: 'ready', shared: shared !== null, capacity: message.config.fluid.capacity });
        return;
      }
      case 'config': {
        obstacles = message.obstacles;
        zones = message.zones;
        return;
      }
      case 'spawn': {
        solver?.spawn(message.amount, message.x, message.y, message.z, message.sx, message.sy, message.sz);
        return;
      }
      case 'step': {
        if (solver === null) return;
        const t0 = performance.now();
        solver.step(message.dt, obstacles);
        absorb();
        const stepMs = performance.now() - t0;
        if (shared !== null) {
          shared.publish(solver.positions, solver.count, stepMs, absorbedTotal, zoneCounts);
        } else {
          const copy = solver.positions.slice(0, solver.count * 3);
          reply(
            {
              type: 'sync',
              buffer: copy.buffer,
              count: solver.count,
              stepMs,
              absorbedTotal,
              zones: [...zoneCounts],
            },
            [copy.buffer],
          );
        }
        return;
      }
      case 'reset': {
        solver?.reset();
        absorbedTotal = 0;
        zoneCounts.fill(0);
        return;
      }
      case 'dispose': {
        solver = null;
        scope.close();
        return;
      }
    }
  };

  scope.addEventListener('message', (event) => {
    const message = event.data as MainToWorker;
    try {
      handle(message);
    } catch (error) {
      reply({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  });
}
