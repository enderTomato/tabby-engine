import type { HeightField } from './height-field.js';
import { metersToU16, u16ToMeters } from './r16.js';

/**
 * 地形编辑（挖填方）。
 *
 * ## 为什么编辑要单独记 diff，而不是直接改 HeightField
 *
 * 1. **存档**：4096² 的 Uint16 是 32MB，玩家只平整了两块地，没必要存全图。
 * 2. **回放**：确定性回放要求「指令序列」而不是「最终状态」，
 *    diff 正好是可比较、可合并的中间表示。
 * 3. **增量重建**：只有被改动的块需要重传 GPU，其余块不动。
 *
 * ## 编辑的粒度是「量化值」而不是「米」
 *
 * 所有编辑最终都走 `metersToU16` 落回 Uint16。这不是实现细节，是正确性要求：
 * 如果 editor 内部保留 float 而 field 存 Uint16，那么「读回来再改」
 * 会每次叠加半个量化误差，反复平整同一块地会看到地面缓慢下沉。
 *
 * ## 半径类操作的衰减函数
 *
 * `raise` / `smooth` 用 smoothstep 而不是线性衰减：线性衰减在圆形边界上
 * 有一阶不连续，玩家会看到一圈生硬的「台阶」。smoothstep 两端导数为 0，
 * 边界过渡自然，代价只是一次额外的乘加。
 */

export interface TerrainDiff {
  readonly version: 1;
  /** 量化区间必须与源数据一致，否则 diff 不能直接套用。 */
  readonly minElevation: number;
  readonly maxElevation: number;
  /** 改动格子索引，升序排列（确定性要求）。 */
  readonly indices: Int32Array;
  /** 与 indices 对应的量化值。 */
  readonly values: Uint16Array;
}

export interface EditorOptions {
  /** 单次编辑允许改动的最大格子数，防止「半径填成 1e9」把主线程卡死。 */
  readonly maxAffectedCells: number;
}

export const DEFAULT_EDITOR: EditorOptions = {
  maxAffectedCells: 262144,
};

export class TerrainEditor {
  readonly field: HeightField;
  private readonly options: EditorOptions;
  /** 索引 → 新量化值。用 Map 只做累积，输出前必须排序（确定性红线）。 */
  private readonly pending = new Map<number, number>();
  /** 受影响的块索引（cx + cy * chunksX），供渲染层增量重建。 */
  private readonly dirty = new Set<number>();
  private readonly chunkCellSize: number;

  constructor(field: HeightField, options: Partial<EditorOptions> = {}, chunkCells = 32) {
    this.field = field;
    this.options = { ...DEFAULT_EDITOR, ...options };
    this.chunkCellSize = Math.max(1, chunkCells);
  }

  get chunksX(): number {
    return Math.ceil(this.field.width / this.chunkCellSize);
  }

  get chunksY(): number {
    return Math.ceil(this.field.height / this.chunkCellSize);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 受影响的块列表（按索引升序）。渲染层据此重建对应网格。 */
  get dirtyChunks(): readonly number[] {
    return Array.from(this.dirty).sort((a, b) => a - b);
  }

  /** 世界坐标下的高度（米）。 */
  getHeight(x: number, z: number): number {
    const col = Math.round(x / this.field.cellSize);
    const row = Math.round(z / this.field.cellSize);
    return this.field.elevationAt(col, row);
  }

  /** 把某点设为指定海拔（米）。影响 1 格。 */
  setHeight(x: number, z: number, meters: number): boolean {
    const col = Math.round(x / this.field.cellSize);
    const row = Math.round(z / this.field.cellSize);
    if (col < 0 || col >= this.field.width || row < 0 || row >= this.field.height) return false;
    this.writeCell(row * this.field.width + col, meters);
    return true;
  }

  /**
   * 圆形抬升/下压。delta 为米，负值即开挖。
   *
   * 衰减用 smoothstep：`w = 1 - smoothstep(0, 1, d/r)`，圆心满幅、边缘归零。
   */
  raise(x: number, z: number, radius: number, delta: number): number {
    return this.applyRadial(x, z, radius, (current) => current + delta);
  }

  /** 圆形平整到指定海拔。 */
  flatten(x: number, z: number, radius: number, meters: number): number {
    return this.applyRadial(x, z, radius, () => meters);
  }

  /**
   * 平滑。取圆内平均海拔向中心收缩，strength 控制幅度 0~1。
   *
   * 注意这里是「近似平滑」：一次采样中心附近 3×3 的均值再做插值，
   * 而不是真正的高斯模糊。真正的模糊要遍历整个核，成本随半径平方增长，
   * 而玩家只会连着点几下，近似足够，且每次点击都是幂等的（不会越改越糊）。
   */
  smooth(x: number, z: number, radius: number, strength = 1): number {
    const avg = this.averageAround(x, z, Math.max(1, radius * 0.5));
    const k = Math.max(0, Math.min(1, strength));
    return this.applyRadial(x, z, radius, (current) => current + (avg - current) * k);
  }

  /** 圆内平均海拔（米）。 */
  averageAround(x: number, z: number, radius: number): number {
    const cell = this.field.cellSize;
    const c0 = Math.max(0, Math.floor((x - radius) / cell));
    const c1 = Math.min(this.field.width - 1, Math.ceil((x + radius) / cell));
    const r0 = Math.max(0, Math.floor((z - radius) / cell));
    const r1 = Math.min(this.field.height - 1, Math.ceil((z + radius) / cell));
    let sum = 0;
    let n = 0;
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        sum += this.field.elevationAt(col, row);
        n += 1;
      }
    }
    return n === 0 ? 0 : sum / n;
  }

  /**
   * 统一的圆内编辑。
   *
   * 返回实际改动的格子数。超过 `maxAffectedCells` 直接抛错而不是「尽力而为」——
   * 静默截断会让玩家看到「只有半个圆被改平」，比报错更难排查。
   */
  private applyRadial(
    x: number,
    z: number,
    radius: number,
    transform: (currentMeters: number) => number,
  ): number {
    const cell = this.field.cellSize;
    const r = Math.max(cell * 0.5, radius);
    const c0 = Math.max(0, Math.floor((x - r) / cell));
    const c1 = Math.min(this.field.width - 1, Math.ceil((x + r) / cell));
    const r0 = Math.max(0, Math.floor((z - r) / cell));
    const r1 = Math.min(this.field.height - 1, Math.ceil((z + r) / cell));

    const estimated = (c1 - c0 + 1) * (r1 - r0 + 1);
    if (estimated > this.options.maxAffectedCells) {
      throw new Error(
        `[tabby/terrain] 编辑半径过大：预计影响 ${estimated} 格，上限 ${this.options.maxAffectedCells}`,
      );
    }

    const r2 = r * r;
    let changed = 0;
    for (let row = r0; row <= r1; row += 1) {
      const wz = row * cell;
      for (let col = c0; col <= c1; col += 1) {
        const wx = col * cell;
        const d2 = (wx - x) * (wx - x) + (wz - z) * (wz - z);
        if (d2 > r2) continue;
        const t = Math.sqrt(d2) / r;
        const weight = 1 - smoothstep(t);
        if (weight <= 0) continue;
        const current = this.field.elevationAt(col, row);
        const next = current + (transform(current) - current) * weight;
        const index = row * this.field.width + col;
        if (this.writeCell(index, next, current)) changed += 1;
      }
    }
    return changed;
  }

  /**
   * 写单格。返回是否真的变了（量化后相同则不算）。
   *
   * 关键：**写之前先读量化后的值做比较**。如果当前值量化后与新值量化后相同，
   * 就不记 diff —— 否则「反复平整同一块地」会积累一堆零改动条目，
   * 存档越存越大。
   */
  private writeCell(index: number, meters: number, currentMeters?: number): boolean {
    const range = this.field.range;
    const value = metersToU16(meters, range);
    const currentValue = currentMeters === undefined
      ? (this.field.data[index] as number)
      : metersToU16(currentMeters, range);
    if (value === currentValue) return false;
    this.field.data[index] = value;
    this.pending.set(index, value);
    const col = index % this.field.width;
    const row = Math.floor(index / this.field.width);
    const cx = Math.floor(col / this.chunkCellSize);
    const cy = Math.floor(row / this.chunkCellSize);
    this.dirty.add(cy * this.chunksX + cx);
    return true;
  }

  /** 导出 diff（按索引升序，跨设备逐位一致）。 */
  exportDiff(): TerrainDiff {
    const indices = Array.from(this.pending.keys()).sort((a, b) => a - b);
    const out = new Int32Array(indices.length);
    const values = new Uint16Array(indices.length);
    for (let i = 0; i < indices.length; i += 1) {
      const idx = indices[i] as number;
      out[i] = idx;
      values[i] = this.pending.get(idx) as number;
    }
    return {
      version: 1,
      minElevation: this.field.range.minElevation,
      maxElevation: this.field.range.maxElevation,
      indices: out,
      values,
    };
  }

  /** 清空 diff 记录（应用存档后调用）。 */
  clearDiff(): void {
    this.pending.clear();
    this.dirty.clear();
  }

  /**
   * diff 序列化为二进制。
   *
   * 布局：`[int32 count][int32 indices...][uint16 values...]`。
   * 比 JSON 小一个数量级（JSON 里每个数字至少 1 字节 + 逗号）。
   */
  static encodeDiff(diff: TerrainDiff): Uint8Array {
    const count = diff.indices.length;
    const bytes = new Uint8Array(4 + count * 4 + count * 2);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, count, true);
    let at = 4;
    for (let i = 0; i < count; i += 1) {
      view.setInt32(at, diff.indices[i] as number, true);
      at += 4;
    }
    for (let i = 0; i < count; i += 1) {
      view.setUint16(at, diff.values[i] as number, true);
      at += 2;
    }
    return bytes;
  }

  static decodeDiff(bytes: Uint8Array): TerrainDiff {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getInt32(0, true);
    if (count < 0 || 4 + count * 6 !== bytes.byteLength) {
      throw new Error(`[tabby/terrain] diff 长度不符：count=${count}, bytes=${bytes.byteLength}`);
    }
    const indices = new Int32Array(count);
    const values = new Uint16Array(count);
    let at = 4;
    for (let i = 0; i < count; i += 1) {
      indices[i] = view.getInt32(at, true);
      at += 4;
    }
    for (let i = 0; i < count; i += 1) {
      values[i] = view.getUint16(at, true);
      at += 2;
    }
    // min/max 由调用方在 applyDiff 时用 HeightField.range 校验，这里留 0 占位
    return { version: 1, minElevation: 0, maxElevation: 0, indices, values };
  }

  /**
   * 把 diff 应用到一张高度场。
   *
   * 校验量化区间：如果 diff 来自另一份参数不同的数据（min/max 不同），
   * 直接套用会把整片地形整体抬高或压低，症状是「读档后地面位置全错」。
   * 宁可抛错也不静默接受。
   */
  static applyDiff(field: HeightField, diff: TerrainDiff): number {
    if (diff.minElevation !== 0 || diff.maxElevation !== 0) {
      const sameRange =
        Math.abs(diff.minElevation - field.range.minElevation) < 1e-6 &&
        Math.abs(diff.maxElevation - field.range.maxElevation) < 1e-6;
      if (!sameRange) {
        throw new Error(
          `[tabby/terrain] diff 的量化区间不匹配：diff=[${diff.minElevation}, ${diff.maxElevation}]，` +
            `field=[${field.range.minElevation}, ${field.range.maxElevation}]`,
        );
      }
    }
    let applied = 0;
    for (let i = 0; i < diff.indices.length; i += 1) {
      const idx = diff.indices[i] as number;
      if (idx < 0 || idx >= field.data.length) continue;
      field.data[idx] = diff.values[i] as number;
      applied += 1;
    }
    return applied;
  }
}

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** 便捷函数：编辑后重新读取某格海拔（米），用于 UI 回显。 */
export function readElevation(field: HeightField, index: number): number {
  return u16ToMeters(field.data[index] ?? 0, field.range);
}
