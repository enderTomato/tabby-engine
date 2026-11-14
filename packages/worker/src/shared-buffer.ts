import {
  HEADER_ABSORB_TOTAL,
  HEADER_FLUID_COUNT,
  HEADER_INTS,
  HEADER_SEQ,
  HEADER_STEP_MS_X100,
  HEADER_ZONE_BASE,
  MAX_ABSORB_ZONES,
} from './protocol.js';

export interface SharedReadResult {
  readonly positions: Float32Array;
  readonly count: number;
  readonly stepMs: number;
  readonly absorbedTotal: number;
  readonly zones: readonly number[];
}

/**
 * 流体共享缓冲区（双缓冲 + seqlock）。
 *
 * 为什么不直接一读一写同一块内存：主线程可能在 Worker 写到一半时读，
 * 会拿到「一半新一半旧」的坐标，视觉上是粒子被拉成面条。
 * seqlock 的代价只有两次 Atomics.load，读失败就沿用上一帧，绝不阻塞主线程。
 */
export class SharedFluidBuffer {
  readonly sab: SharedArrayBuffer;
  readonly header: Int32Array;
  readonly capacity: number;

  private readonly bufferA: Float32Array;
  private readonly bufferB: Float32Array;

  /** 传 number 表示新建（主线程侧）；传 SAB 表示接入已存在的缓冲（Worker 侧）。 */
  constructor(source: number | SharedArrayBuffer) {
    const headerBytes = HEADER_INTS * 4;
    if (typeof source === 'number') {
      this.capacity = Math.max(1, Math.floor(source));
      const floatBytes = this.capacity * 3 * 4;
      this.sab = new SharedArrayBuffer(headerBytes + floatBytes * 2);
    } else {
      this.capacity = Math.max(1, Math.floor((source.byteLength - headerBytes) / (3 * 4 * 2)));
      this.sab = source;
    }
    const floatBytes = this.capacity * 3 * 4;
    this.header = new Int32Array(this.sab, 0, HEADER_INTS);
    this.bufferA = new Float32Array(this.sab, headerBytes, this.capacity * 3);
    this.bufferB = new Float32Array(this.sab, headerBytes + floatBytes, this.capacity * 3);
  }

  /** Worker 侧：写入一帧数据。 */
  publish(positions: Float32Array, count: number, stepMs: number, absorbedTotal: number, zones: readonly number[]): void {
    const seq = Atomics.add(this.header, HEADER_SEQ, 1) >>> 0;
    const target = Math.floor(seq / 2) % 2 === 0 ? this.bufferA : this.bufferB;
    const n = Math.min(count, this.capacity);
    target.set(positions.subarray(0, n * 3));
    Atomics.store(this.header, HEADER_FLUID_COUNT, n);
    Atomics.store(this.header, HEADER_STEP_MS_X100, Math.round(stepMs * 100));
    Atomics.store(this.header, HEADER_ABSORB_TOTAL, absorbedTotal);
    for (let i = 0; i < MAX_ABSORB_ZONES; i += 1) {
      Atomics.store(this.header, HEADER_ZONE_BASE + i, zones[i] ?? 0);
    }
    Atomics.store(this.header, HEADER_SEQ, seq + 1);
  }

  /** 主线程侧：尝试读取最新一帧，读到「写入中」返回 null。 */
  read(): SharedReadResult | null {
    const s1 = Atomics.load(this.header, HEADER_SEQ);
    if (s1 === 0 || (s1 & 1) !== 0) return null;
    const source = Math.floor((s1 - 1) / 2) % 2 === 0 ? this.bufferA : this.bufferB;
    const count = Atomics.load(this.header, HEADER_FLUID_COUNT);
    const stepMs = Atomics.load(this.header, HEADER_STEP_MS_X100) / 100;
    const absorbedTotal = Atomics.load(this.header, HEADER_ABSORB_TOTAL);
    const zones: number[] = [];
    for (let i = 0; i < MAX_ABSORB_ZONES; i += 1) {
      zones.push(Atomics.load(this.header, HEADER_ZONE_BASE + i));
    }
    const s2 = Atomics.load(this.header, HEADER_SEQ);
    if (s1 !== s2) return null;
    return { positions: source, count, stepMs, absorbedTotal, zones };
  }
}
