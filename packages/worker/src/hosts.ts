import { FluidSolver, type FluidOptions, type Obstacle } from '@tabby/physics';
import { MAX_ABSORB_ZONES, type AbsorbZone, type MainToWorker, type WorkerToMain } from './protocol.js';
import { SharedFluidBuffer } from './shared-buffer.js';

export type FluidHostMode = 'worker-shared' | 'worker-copy' | 'local';

export interface FluidHostConfig {
  readonly fluid: FluidOptions;
  readonly obstacles?: readonly Obstacle[];
  readonly zones?: readonly AbsorbZone[];
}

export interface FluidHostStats {
  readonly mode: FluidHostMode;
  readonly count: number;
  readonly capacity: number;
  readonly stepMs: number;
  readonly absorbedTotal: number;
  readonly zones: readonly number[];
}

/**
 * 流体宿主抽象：同一套 API 背后可以是 Worker(SAB) / Worker(postMessage) / 主线程。
 * 业务代码永远只依赖这个接口，降级对上层不可见。
 */
export interface FluidHost {
  readonly mode: FluidHostMode;
  start(config: FluidHostConfig): Promise<void>;
  step(dt: number): void;
  spawn(amount: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void;
  setConfig(obstacles: readonly Obstacle[], zones: readonly AbsorbZone[]): void;
  reset(): void;
  positions(): Float32Array | null;
  count(): number;
  zoneCounts(): readonly number[];
  stats(): FluidHostStats;
  dispose(): void;
}

/** 主线程实现：同时作为 Worker 不可用时的兜底路径。 */
export class LocalFluidHost implements FluidHost {
  readonly mode: FluidHostMode = 'local';

  private solver: FluidSolver | null = null;
  private obstacles: readonly Obstacle[] = [];
  private zones: readonly AbsorbZone[] = [];
  private absorbedTotal = 0;
  private readonly zoneTotals: number[] = new Array(MAX_ABSORB_ZONES).fill(0);
  private lastStepMs = 0;

  start(config: FluidHostConfig): Promise<void> {
    this.solver = new FluidSolver(config.fluid, 1337);
    this.obstacles = config.obstacles ?? [];
    this.zones = config.zones ?? [];
    return Promise.resolve();
  }

  step(dt: number): void {
    if (this.solver === null) return;
    const t0 = performance.now();
    this.solver.step(dt, this.obstacles);
    this.absorb();
    this.lastStepMs = performance.now() - t0;
  }

  spawn(amount: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    this.solver?.spawn(amount, x, y, z, sx, sy, sz);
  }

  setConfig(obstacles: readonly Obstacle[], zones: readonly AbsorbZone[]): void {
    this.obstacles = obstacles;
    this.zones = zones;
  }

  reset(): void {
    this.solver?.reset();
    this.absorbedTotal = 0;
    this.zoneTotals.fill(0);
  }

  positions(): Float32Array | null {
    return this.solver === null ? null : this.solver.positions;
  }

  count(): number {
    return this.solver?.count ?? 0;
  }

  zoneCounts(): readonly number[] {
    return this.zoneTotals;
  }

  stats(): FluidHostStats {
    return {
      mode: this.mode,
      count: this.count(),
      capacity: this.solver?.capacity ?? 0,
      stepMs: this.lastStepMs,
      absorbedTotal: this.absorbedTotal,
      zones: [...this.zoneTotals],
    };
  }

  dispose(): void {
    this.solver?.reset();
    this.solver = null;
  }

  private absorb(): void {
    const solver = this.solver;
    if (solver === null || this.zones.length === 0) return;
    const positions = solver.positions;
    for (let z = 0; z < this.zones.length && z < MAX_ABSORB_ZONES; z += 1) {
      const zone = this.zones[z];
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
          const last = solver.count - 1;
          solver.despawn(i);
          if (i !== last) {
            positions[i * 3] = positions[last * 3] ?? 0;
            positions[i * 3 + 1] = positions[last * 3 + 1] ?? 0;
            positions[i * 3 + 2] = positions[last * 3 + 2] ?? 0;
          }
          this.zoneTotals[z] = (this.zoneTotals[z] ?? 0) + 1;
          this.absorbedTotal += 1;
        } else {
          i += 1;
        }
      }
    }
  }
}

export interface WorkerFluidHostOptions {
  readonly workerFactory: () => Worker;
  /** 是否启用 SAB 零拷贝；false 时走 postMessage 传输（每帧一次拷贝）。 */
  readonly shared: boolean;
  readonly capacity: number;
}

/** Worker 实现。SAB 模式下读不到最新帧就沿用上一帧，绝不阻塞。 */
export class WorkerFluidHost implements FluidHost {
  readonly mode: FluidHostMode;

  private readonly options: WorkerFluidHostOptions;
  private worker: Worker | null = null;
  private buffer: SharedFluidBuffer | null = null;
  private copyPositions: Float32Array | null = null;
  private copyCount = 0;
  private resolvedPositions: Float32Array | null = null;
  private resolvedCount = 0;
  private lastStepMs = 0;
  private absorbedTotal = 0;
  private readonly zoneTotals: number[] = new Array(MAX_ABSORB_ZONES).fill(0);
  private ready = false;

  constructor(options: WorkerFluidHostOptions) {
    this.options = options;
    this.mode = options.shared ? 'worker-shared' : 'worker-copy';
  }

  start(config: FluidHostConfig): Promise<void> {
    const worker = this.options.workerFactory();
    this.worker = worker;
    if (this.options.shared) {
      this.buffer = new SharedFluidBuffer(this.options.capacity);
    }
    return new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const message = event.data as WorkerToMain;
        if (message.type === 'ready') {
          this.ready = true;
          worker.removeEventListener('message', onMessage);
          resolve();
          worker.addEventListener('message', this.onWorkerMessage);
          return;
        }
        if (message.type === 'error') {
          worker.removeEventListener('message', onMessage);
          reject(new Error(message.message));
        }
      };
      worker.addEventListener('message', onMessage);
      const init: MainToWorker = {
        type: 'init',
        config: { fluid: config.fluid, obstacles: config.obstacles ?? [], zones: config.zones ?? [] },
        ...(this.buffer !== null ? { shared: this.buffer.sab } : {}),
      };
      worker.postMessage(init);
    });
  }

  step(dt: number): void {
    if (!this.ready || this.worker === null) return;
    const message: MainToWorker = { type: 'step', dt };
    this.worker.postMessage(message);
    this.pull();
  }

  spawn(amount: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    if (!this.ready || this.worker === null) return;
    const message: MainToWorker = { type: 'spawn', amount, x, y, z, sx, sy, sz };
    this.worker.postMessage(message);
  }

  setConfig(obstacles: readonly Obstacle[], zones: readonly AbsorbZone[]): void {
    if (!this.ready || this.worker === null) return;
    const message: MainToWorker = { type: 'config', obstacles, zones };
    this.worker.postMessage(message);
  }

  reset(): void {
    if (!this.ready || this.worker === null) return;
    const message: MainToWorker = { type: 'reset' };
    this.worker.postMessage(message);
    this.copyPositions = null;
    this.copyCount = 0;
    this.resolvedPositions = null;
    this.resolvedCount = 0;
  }

  positions(): Float32Array | null {
    return this.resolvedPositions;
  }

  count(): number {
    return this.resolvedCount;
  }

  zoneCounts(): readonly number[] {
    return this.zoneTotals;
  }

  stats(): FluidHostStats {
    return {
      mode: this.mode,
      count: this.resolvedCount,
      capacity: this.options.capacity,
      stepMs: this.lastStepMs,
      absorbedTotal: this.absorbedTotal,
      zones: [...this.zoneTotals],
    };
  }

  dispose(): void {
    if (this.worker !== null) {
      const message: MainToWorker = { type: 'dispose' };
      this.worker.postMessage(message);
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
  }

  private readonly onWorkerMessage = (event: MessageEvent): void => {
    const message = event.data as WorkerToMain;
    if (message.type === 'sync') {
      this.copyPositions = new Float32Array(message.buffer);
      this.copyCount = message.count;
      this.lastStepMs = message.stepMs;
      this.absorbedTotal = message.absorbedTotal;
      this.resolvedPositions = this.copyPositions;
      this.resolvedCount = this.copyCount;
      for (let i = 0; i < MAX_ABSORB_ZONES; i += 1) {
        this.zoneTotals[i] = message.zones[i] ?? 0;
      }
      return;
    }
    if (message.type === 'error') {
      console.error('[tabby/worker] worker 错误:', message.message);
    }
  };

  private pull(): void {
    if (this.buffer === null) return;
    const snapshot = this.buffer.read();
    if (snapshot === null) {
      // 正在写入：沿用上一帧，下一帧再取
      return;
    }
    this.resolvedPositions = snapshot.positions;
    this.resolvedCount = snapshot.count;
    this.lastStepMs = snapshot.stepMs;
    this.absorbedTotal = snapshot.absorbedTotal;
    for (let i = 0; i < MAX_ABSORB_ZONES; i += 1) {
      this.zoneTotals[i] = snapshot.zones[i] ?? 0;
    }
  }
}

export interface CreateFluidHostOptions {
  readonly capacity: number;
  /** 由平台层计算：是否具备 SAB + COI + Worker。 */
  readonly sharedAvailable: boolean;
  readonly workerAllowed: boolean;
  readonly workerFactory?: (() => Worker) | null;
}

/** 能力探测 → 选择最优宿主，调用方不需要知道细节。 */
export function createFluidHost(options: CreateFluidHostOptions): FluidHost {
  const factory = options.workerFactory ?? null;
  if (options.workerAllowed && factory !== null) {
    const shared = options.sharedAvailable && typeof SharedArrayBuffer !== 'undefined';
    return new WorkerFluidHost({ workerFactory: factory, shared, capacity: options.capacity });
  }
  return new LocalFluidHost();
}
