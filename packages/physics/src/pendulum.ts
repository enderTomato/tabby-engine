export interface PendulumConfig {
  /** 摆长（米）。 */
  readonly length: number;
  readonly gravity: number;
  /** 角阻尼，0.05~0.3 之间手感最好。 */
  readonly damping: number;
  readonly angle?: number;
  readonly angularVelocity?: number;
  /** 每步内部子步数，低端机可降到 2。 */
  readonly substeps?: number;
}

/**
 * 解析单摆（含驱动力矩）。
 *
 * 用途：风车/水车/吊灯/旗帜这类「周期摆动」物件。
 * 相比布娃娃的 Verlet 约束，解析解在任意帧率下都不会漂移，
 * 且成本只有几次三角函数，可以放心上几十个实例。
 */
export class Pendulum {
  readonly config: PendulumConfig;
  angle: number;
  angularVelocity: number;
  /** 外部持续力矩（如水流冲击水车）。 */
  driveTorque = 0;

  constructor(config: PendulumConfig) {
    this.config = config;
    this.angle = config.angle ?? 0.6;
    this.angularVelocity = config.angularVelocity ?? 0;
  }

  step(dt: number): void {
    const g = this.config.gravity;
    const l = Math.max(0.05, this.config.length);
    const damping = this.config.damping;
    const substeps = Math.max(1, Math.floor(this.config.substeps ?? 4));
    const h = dt / substeps;
    for (let s = 0; s < substeps; s += 1) {
      const acceleration = -(g / l) * Math.sin(this.angle) - damping * this.angularVelocity + this.driveTorque;
      // 半隐式欧拉 + 每子步限速，避免 dt 抖动导致发散
      this.angularVelocity += acceleration * h;
      this.angularVelocity = Math.max(-20, Math.min(20, this.angularVelocity));
      this.angle += this.angularVelocity * h;
    }
    // 角度归一化到 [-π, π]，避免长时间运行后精度下降
    if (this.angle > Math.PI || this.angle < -Math.PI) {
      this.angle = Math.atan2(Math.sin(this.angle), Math.cos(this.angle));
    }
  }

  get tipOffsetX(): number {
    return Math.sin(this.angle) * this.config.length;
  }

  get tipOffsetY(): number {
    return -Math.cos(this.angle) * this.config.length;
  }

  reset(angle: number, angularVelocity = 0): void {
    this.angle = angle;
    this.angularVelocity = angularVelocity;
  }
}
