export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PhysicsBounds {
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

/** 静态障碍盒。流体/布娃娃/烟雾都对其做推出，不做旋转盒（成本收益不划算）。 */
export interface Obstacle {
  readonly id: string;
  readonly min: Vec3Like;
  readonly max: Vec3Like;
  /** solid: 完全阻挡；permeable: 只做阻尼（如灌木、栅栏），供游戏性使用。 */
  readonly kind: 'solid' | 'permeable';
}

export interface FluidOptions {
  readonly capacity: number;
  /** 核半径 h（世界单位，通常 0.8~1.2）。 */
  readonly smoothingRadius: number;
  /** 静止密度，数值越大粒子排布越疏。 */
  readonly restDensity: number;
  /** PBF 迭代次数，1 次最省，3 次最稳。 */
  readonly iterations: number;
  /** XSPH 粘性系数。 */
  readonly viscosity: number;
  /** 重力加速度标量（沿 -Y）。 */
  readonly gravity: number;
  readonly bounds: PhysicsBounds;
  /** 粒子碰撞半径，用于边界与障碍推出。 */
  readonly radius: number;
  /** 单步最大位移（世界单位/秒），防止数值爆炸。 */
  readonly maxSpeed: number;
  /** 抗聚集修正强度（0 关闭）。 */
  readonly surfaceTension: number;
}

export interface FluidStats {
  readonly count: number;
  readonly capacity: number;
  readonly gridCells: number;
  readonly avgNeighbors: number;
  readonly maxDensityError: number;
  readonly stepMs: number;
}

export interface PhysicsStats {
  readonly fluidCount: number;
  readonly smokeCount: number;
  readonly ragdollCount: number;
  /** 处于休眠的布娃娃数量。城市里躺倒的尸体越多这个数越大。 */
  readonly sleepingRagdolls: number;
  readonly obstacleCount: number;
  /** 宽相位网格实际插入的「盒 × 格」实例数。 */
  readonly gridInstances: number;
  /** true 表示宽相位实例池溢出，已退化为暴力遍历。 */
  readonly gridDegraded: boolean;
  readonly simulationTime: number;
  readonly lastStepMs: number;
}

export interface RagdollOptions {
  readonly gravity: number;
  readonly damping: number;
  readonly iterations: number;
  /** 地面平面 y 值。 */
  readonly groundY: number;
  /** 地面与障碍摩擦，0~1。 */
  readonly friction: number;
  readonly bounds: PhysicsBounds;
  /**
   * 关节弯曲软限制：相邻两骨的最小 |a-c| 占「完全伸直」的比例。
   * 0.55 约等于关节最小夹角 120°，0.95 几乎不限制。
   */
  readonly bendLimit?: number;
  /** 静止多久后进入休眠（秒）。0 表示禁用休眠。 */
  readonly sleepDelay?: number;
  /** 休眠速度阈值（m/s）。低于该值才算「静止」。 */
  readonly sleepThreshold?: number;
}

export interface SmokeOptions {
  readonly capacity: number;
  readonly gravity: number;
  /** 浮力加速度（正值向 +Y）。 */
  readonly buoyancy: number;
  readonly drag: number;
  /** 生命周期（秒）。 */
  readonly life: number;
  readonly startSize: number;
  readonly endSize: number;
  readonly bounds: PhysicsBounds;
}
