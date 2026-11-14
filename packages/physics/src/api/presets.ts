import type { ForceContext, CustomConstraint, ConstraintContext, ForceField } from './extension.js';
import { WindField } from '../wind.js';

/**
 * 内置扩展（Presets）。
 *
 * 这三个实现同时也是「如何扩展物理引擎」的完整示例：
 * - `createWindForce`：每帧持续力场，注意跳过休眠对象；
 * - `createExplosionForce`：一次性冲量，用完自动移除；
 * - `createLeashConstraint`：自定义约束，限制某点离锚点的最大距离。
 *
 * 三者都不 import 渲染层，也不假设场景结构 —— 这是 Extension 层的底线。
 */

export interface WindForceOptions {
  /** 风对布娃娃的拖曳强度（m/s² 每单位风速）。布娃娃比烟重，需要更大的值。 */
  readonly strength?: number;
  /** 是否唤醒休眠的布娃娃。默认 false：地上的尸体不该被微风吹得乱动。 */
  readonly wakeSleeping?: boolean;
}

/**
 * 风力场。
 *
 * 用「相对风速」而不是绝对风速：静止的空气对物体不施力。
 * 这点在低风速下尤其重要 —— 用绝对风速会让布娃娃在无风时也缓慢漂移。
 */
export function createWindForce(
  id: string,
  wind: WindField,
  options: WindForceOptions = {},
): ForceField {
  const strength = options.strength ?? 1.6;
  const wakeSleeping = options.wakeSleeping ?? false;
  const sample = new Float32Array(3);

  return {
    id,
    apply(ctx: ForceContext, dt: number): void {
      const ragdolls = ctx.ragdolls;
      for (let r = 0; r < ragdolls.length; r += 1) {
        const ragdoll = ragdolls[r];
        if (ragdoll === undefined) continue;
        if (ragdoll.isAsleep && !wakeSleeping) continue;
        // 用第一个点采一次风，而不是每点采样：布娃娃尺度只有 1~2 米，
        // 风在这个尺度上是均匀的，逐点采样只会多花噪声成本
        const px = ragdoll.positions[0] as number;
        const py = ragdoll.positions[1] as number;
        const pz = ragdoll.positions[2] as number;
        wind.sample(px, py, pz, ctx.time, sample);
        ragdoll.addAcceleration(
          (sample[0] as number) * strength,
          (sample[1] as number) * strength,
          (sample[2] as number) * strength,
          dt,
        );
      }
    },
  };
}

export interface ExplosionOptions {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 影响半径（米）。 */
  readonly radius: number;
  /** 中心冲量（m/s）。 */
  readonly power: number;
  /** 是否只触发一次（默认 true）。 */
  readonly once?: boolean;
}

/**
 * 爆炸冲击（一次性）。
 *
 * 直接走 `addRadialImpulse` 而不是加加速度：
 * 爆炸是「给速度」，不是「给力」，用力的形式会让弱爆炸几乎没效果、强爆炸过冲。
 */
export function createExplosionForce(id: string, options: ExplosionOptions): ForceField {
  let fired = false;
  return {
    id,
    apply(ctx: ForceContext): void {
      if (fired && (options.once ?? true)) return;
      fired = true;
      for (let r = 0; r < ctx.ragdolls.length; r += 1) {
        ctx.ragdolls[r]?.addRadialImpulse(options.x, options.y, options.z, options.radius, options.power);
      }
    },
  };
}

/**
 * 牵引约束：限制指定点离锚点的最大距离。
 *
 * 这是 P09 要求的「用户扩展一个自定义约束」的完整示例。要点：
 * - `solve` 里只做位置修正，不改速度（速度由下一次 Verlet 积分自然产生）；
 * - 修正量按 invMass 分配，避免把固定的点拉走；
 * - 不用 `Math.hypot` 之外的开方 —— 每步只算一次距离。
 */
export function createLeashConstraint(
  id: string,
  ragdollId: string,
  pointIndex: number,
  anchor: { readonly x: number; readonly y: number; readonly z: number },
  maxDistance: number,
): CustomConstraint {
  return {
    id,
    solve(ctx: ConstraintContext): void {
      for (let r = 0; r < ctx.ragdolls.length; r += 1) {
        const ragdoll = ctx.ragdolls[r];
        if (ragdoll === undefined || ragdoll.id !== ragdollId) continue;
        const i = pointIndex;
        if (i < 0 || i >= ragdoll.pointCount) return;
        const dx = (ragdoll.positions[i * 3] as number) - anchor.x;
        const dy = (ragdoll.positions[i * 3 + 1] as number) - anchor.y;
        const dz = (ragdoll.positions[i * 3 + 2] as number) - anchor.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist <= maxDistance || dist < 1e-6) return;
        const k = maxDistance / dist;
        ragdoll.positions[i * 3] = anchor.x + dx * k;
        ragdoll.positions[i * 3 + 1] = anchor.y + dy * k;
        ragdoll.positions[i * 3 + 2] = anchor.z + dz * k;
      }
    },
  };
}
