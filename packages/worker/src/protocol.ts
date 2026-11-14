import type { FluidOptions, Obstacle, Vec3Like } from '@tabby/physics';

/**
 * SAB 共享头部布局（全部 Int32，共 HEADER_INTS 个槽）。
 * 只在这里定义一次，主线程与 Worker 共用，避免两端偏移不一致。
 */
export const HEADER_INTS = 16;
export const HEADER_SEQ = 0;
export const HEADER_FLUID_COUNT = 1;
export const HEADER_SMOKE_COUNT = 2;
export const HEADER_FLAGS = 3;
export const HEADER_STEP_MS_X100 = 4;
export const HEADER_ABSORB_TOTAL = 5;
export const HEADER_ZONE_BASE = 6;
export const MAX_ABSORB_ZONES = 8;

/** 吸收区：连通的粒子会被移出模拟并计入计数（如农田灌溉、下水口）。 */
export interface AbsorbZone {
  readonly id: string;
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

export interface FluidWorkerConfig {
  readonly fluid: FluidOptions;
  readonly obstacles: readonly Obstacle[];
  readonly zones: readonly AbsorbZone[];
}

export type MainToWorker =
  | { readonly type: 'init'; readonly config: FluidWorkerConfig; readonly shared?: SharedArrayBuffer }
  | { readonly type: 'step'; readonly dt: number }
  | {
      readonly type: 'spawn';
      readonly amount: number;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly sx: number;
      readonly sy: number;
      readonly sz: number;
    }
  | { readonly type: 'config'; readonly obstacles: readonly Obstacle[]; readonly zones: readonly AbsorbZone[] }
  | { readonly type: 'reset' }
  | { readonly type: 'dispose' };

export type WorkerToMain =
  | { readonly type: 'ready'; readonly shared: boolean; readonly capacity: number }
  | {
      readonly type: 'sync';
      readonly buffer: ArrayBuffer;
      readonly count: number;
      readonly stepMs: number;
      readonly absorbedTotal: number;
      readonly zones: readonly number[];
    }
  | { readonly type: 'error'; readonly message: string };

/** Worker 作用域的最小接口，避免为本包引入 WebWorker lib（会与 DOM lib 冲突）。 */
export interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}
