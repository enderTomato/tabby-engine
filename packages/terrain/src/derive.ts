import type { HeightField } from './height-field.js';

/**
 * 派生图烘焙：坡度图与可建性掩膜。
 *
 * 法线图（`normal.ts`）已经把坡度塞进 A 通道，那为什么还要单独的坡度图：
 *
 * - 部分渲染器/着色器只想要坡度（splat 的岩石层判据），单通道图省 3/4 显存；
 * - 可建性掩膜是**玩法**数据（25° 以上不能盖楼），不应该跟视觉效果耦合在一起；
 *   以后换美术风格重烘焙法线图时，不能顺手把可建性也改掉。
 *
 * 与法线图一样，这是预烘焙产物：地形编辑后必须增量重烘焙脏区域。
 */

/**
 * 坡度图（单通道 8bit）。值 = slope / 90° × 255。
 *
 * 用 8bit 而不是 16bit：坡度在玩法上只关心「能不能建」（25°）与
 * 「是不是悬崖」（60°），0.35° 的分辨率完全够用。16bit 会让显存翻倍。
 */
export function bakeSlope(field: HeightField): Uint8Array {
  const { width, height } = field;
  const out = new Uint8Array(width * height);
  const halfPi = Math.PI / 2;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const slope = field.slopeAt(col, row);
      out[row * width + col] = Math.round(Math.min(1, slope / halfPi) * 255);
    }
  }
  return out;
}

export interface BuildableOptions {
  /** 最大可建坡度（弧度），默认 25°。 */
  readonly maxSlopeRad?: number;
  /** 最低可建海拔（米），低于它算水域，默认用 seaLevel。 */
  readonly minElevation?: number;
  /** 最高可建海拔（米），高于它算雪线以上，默认不限制。 */
  readonly maxElevation?: number;
}

/**
 * 可建性掩膜：1 = 可建，0 = 不可建。
 *
 * 三个判据是「且」关系：坡太陡、在水下、在雪线以上都不行。
 * 商业模拟经营游戏通常还会加「保护区」「已有建筑」等图层，
 * 那些属于玩法层，应该叠在经济模块的地块数据上，不该烘进这张图 ——
 * 否则同一条规则会出现在两个地方，改一处忘一处。
 */
export function bakeBuildableMask(field: HeightField, options: BuildableOptions = {}): Uint8Array {
  const maxSlope = options.maxSlopeRad ?? (25 * Math.PI) / 180;
  const minElevation = options.minElevation ?? field.range.minElevation;
  const maxElevation = options.maxElevation ?? Infinity;
  const { width, height } = field;
  const out = new Uint8Array(width * height);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const elevation = field.elevationAt(col, row);
      if (elevation < minElevation || elevation > maxElevation) continue;
      if (field.slopeAt(col, row) > maxSlope) continue;
      out[row * width + col] = 1;
    }
  }
  return out;
}

/** 统计掩膜里可建格子的占比，给预处理的日志用。 */
export function buildableRatio(mask: Uint8Array): number {
  if (mask.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 1) n += 1;
  }
  return n / mask.length;
}
