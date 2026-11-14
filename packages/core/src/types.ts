/**
 * 基础数据类型。刻意保持为纯数据结构（无类、无方法），
 * 以便跨 Worker / SAB 边界传输与结构化克隆。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb3 {
  min: Vec3;
  max: Vec3;
}

/** 系统执行阶段，按此顺序串行执行，同一阶段内按 order 升序。 */
export type SystemPhase = 'input' | 'physics' | 'update' | 'lateUpdate' | 'render';

export const SYSTEM_PHASES: readonly SystemPhase[] = [
  'input',
  'physics',
  'update',
  'lateUpdate',
  'render',
];

/** 一帧的时间快照，所有系统共享同一份（避免重复计算）。 */
export interface FrameInfo {
  /** 自 start 起的帧序号，从 0 开始。 */
  readonly frame: number;
  /** 本帧真实耗时（毫秒），已做 maxFrameDeltaMs 夹紧。 */
  readonly deltaMs: number;
  /** 累计运行时长（毫秒），不含被丢弃的时间。 */
  readonly elapsedMs: number;
  /** 固定步长插值系数 [0,1)，渲染层用它做状态平滑。 */
  readonly alpha: number;
  /** 本帧执行的固定步数量。 */
  readonly fixedSteps: number;
  /** 因超出 maxSubSteps 被丢弃的时间（毫秒），>0 说明发生追帧失败。 */
  readonly droppedMs: number;
}

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function toVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
