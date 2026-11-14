/**
 * 半开源 API — Public 层。
 *
 * 这是 `@tabby/physics` 的默认入口，也就是 semver 保护的那一层。
 * 规则：
 * - 这里出现的符号，删改都算破坏性变更，只能在大版本做；
 * - 新增字段优先做成可选，避免下游被迫改代码；
 * - 内部实现（`@internal`）不会出现在本文件的导出里，也不会出现在 .d.ts 里。
 *
 * 需要插件能力的代码请从 `@tabby/physics/extension` 导入。
 */

import type {
  Vec3Like,
  PhysicsBounds,
  Obstacle,
  FluidOptions,
  FluidStats,
  PhysicsStats,
  RagdollOptions,
  SmokeOptions,
} from '../types.js';

export type {
  Vec3Like,
  PhysicsBounds,
  Obstacle,
  FluidOptions,
  FluidStats,
  PhysicsStats,
  RagdollOptions,
  SmokeOptions,
};

export { FluidSolver } from '../fluid.js';
export {
  LiquidSystem,
  DEFAULT_LIQUID,
  type LiquidOptions,
  type LiquidSource,
  type LiquidOverflow,
} from '../liquid.js';
export { Ragdoll } from '../ragdoll.js';
export { Pendulum, type PendulumConfig } from '../pendulum.js';
export { DoublePendulum, type DoublePendulumConfig } from '../pendulum-chain.js';
export { SmokeSystem, SMOKE_STRIDE } from '../smoke.js';
export { WindField, DEFAULT_WIND, WIND_STRIDE, type WindConfig } from '../wind.js';
export { ObstacleGrid } from '../spatial-hash.js';
export { PhysicsWorld, DEFAULT_BOUNDS, type PhysicsWorldOptions } from '../world.js';
