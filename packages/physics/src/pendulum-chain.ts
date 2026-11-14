/**
 * 双摆：拉格朗日方程的解析解 + RK4 子步积分。
 *
 * 为什么双摆不也用 Verlet（像 rope 那样）：
 * Verlet 约束会把「双摆」退化成两根绳，丢失第二个质量的惯性耦合 ——
 * 也就是双摆最标志性的「混沌翻滚」完全出不来。双摆的观感来自
 * θ2 对 θ1 的非线性反馈，必须解真正的耦合方程。
 *
 * 为什么三段以上不用解析：
 * N 段链的拉格朗日方程要解 N×N 的质量矩阵（每步 O(N³)），
 * 三段的计算量已经超过同段数的 Verlet 约束 20 倍，而视觉差别微乎其微。
 * 所以本引擎的边界是：**一段用 Pendulum，两段用 DoublePendulum，
 * 三段及以上用 Ragdoll.rope（Verlet）**。
 *
 * 数值：RK4 + 每子步阻尼。双摆是混沌系统，半隐式欧拉在 dt=1/30 时
 * 会明显看到能量漂移（摆幅越转越大），RK4 在 dt=1/30 仍能稳定几十秒。
 */

export interface DoublePendulumConfig {
  /** 上段长度（米）。 */
  readonly length1: number;
  /** 下段长度（米）。 */
  readonly length2: number;
  /** 上段质量（相对值即可，只需比例）。 */
  readonly mass1: number;
  readonly mass2: number;
  readonly gravity: number;
  /** 角阻尼（每秒衰减比例），0.02~0.2。 */
  readonly damping: number;
  readonly angle1?: number;
  readonly angle2?: number;
  readonly velocity1?: number;
  readonly velocity2?: number;
  /** 每步 RK4 子步数，低端机 2，默认 3。 */
  readonly substeps?: number;
}

export class DoublePendulum {
  readonly config: DoublePendulumConfig;
  angle1: number;
  angle2: number;
  velocity1: number;
  velocity2: number;

  /** RK4 中间量，预分配避免每步分配。 */
  private readonly k1 = new Float64Array(4);
  private readonly k2 = new Float64Array(4);
  private readonly k3 = new Float64Array(4);
  private readonly k4 = new Float64Array(4);
  private readonly state = new Float64Array(4);
  private readonly temp = new Float64Array(4);

  constructor(config: DoublePendulumConfig) {
    this.config = config;
    this.angle1 = config.angle1 ?? 1.6;
    this.angle2 = config.angle2 ?? 2.4;
    this.velocity1 = config.velocity1 ?? 0;
    this.velocity2 = config.velocity2 ?? 0;
  }

  step(dt: number): void {
    const substeps = Math.max(1, Math.floor(this.config.substeps ?? 3));
    const h = dt / substeps;
    const damping = Math.max(0, Math.min(0.95, this.config.damping));

    for (let s = 0; s < substeps; s += 1) {
      const y0 = this.state;
      y0[0] = this.angle1;
      y0[1] = this.velocity1;
      y0[2] = this.angle2;
      y0[3] = this.velocity2;

      this.derivative(y0, this.k1);
      addScaled(y0, this.k1, h * 0.5, this.temp);
      this.derivative(this.temp, this.k2);
      addScaled(y0, this.k2, h * 0.5, this.temp);
      this.derivative(this.temp, this.k3);
      addScaled(y0, this.k3, h, this.temp);
      this.derivative(this.temp, this.k4);

      this.angle1 += (h / 6) * ((this.k1[0] as number) + 2 * (this.k2[0] as number) + 2 * (this.k3[0] as number) + (this.k4[0] as number));
      this.velocity1 += (h / 6) * ((this.k1[1] as number) + 2 * (this.k2[1] as number) + 2 * (this.k3[1] as number) + (this.k4[1] as number));
      this.angle2 += (h / 6) * ((this.k1[2] as number) + 2 * (this.k2[2] as number) + 2 * (this.k3[2] as number) + (this.k4[2] as number));
      this.velocity2 += (h / 6) * ((this.k1[3] as number) + 2 * (this.k2[3] as number) + 2 * (this.k3[3] as number) + (this.k4[3] as number));

      // 阻尼只作用在角速度上：直接衰减角度会让摆「缩回去」，物理上不成立
      const decay = 1 - damping * h;
      this.velocity1 *= decay;
      this.velocity2 *= decay;
    }

    // 限速：混沌系统在极端初始条件下会数值爆炸，钳制比事后 NaN 检查便宜
    this.velocity1 = clamp(this.velocity1, -40, 40);
    this.velocity2 = clamp(this.velocity2, -40, 40);
    if (!Number.isFinite(this.angle1) || !Number.isFinite(this.angle2)) {
      this.reset(1.6, 2.4);
    }
  }

  /** 第一段末端相对悬挂点的偏移。 */
  get jointX(): number {
    return Math.sin(this.angle1) * this.config.length1;
  }

  get jointY(): number {
    return -Math.cos(this.angle1) * this.config.length1;
  }

  /** 第二段末端相对悬挂点的偏移。 */
  get tipX(): number {
    return this.jointX + Math.sin(this.angle2) * this.config.length2;
  }

  get tipY(): number {
    return this.jointY - Math.cos(this.angle2) * this.config.length2;
  }

  reset(angle1: number, angle2: number, velocity1 = 0, velocity2 = 0): void {
    this.angle1 = angle1;
    this.angle2 = angle2;
    this.velocity1 = velocity1;
    this.velocity2 = velocity2;
  }

  /**
   * 状态导数：d(θ1)/dt = ω1，d(ω1)/dt = α1，以此类推。
   *
   * 方程来自双摆的拉格朗日形式（两质量两杆、重力场）。
   * 分母 m1 + m2·sin²(θ1-θ2) 在 θ1=θ2 时不为零（等于 m1），无需特判。
   */
  private derivative(y: Float64Array, out: Float64Array): void {
    const { length1: l1, length2: l2, mass1: m1, mass2: m2, gravity: g } = this.config;
    const t1 = y[0] as number;
    const w1 = y[1] as number;
    const t2 = y[2] as number;
    const w2 = y[3] as number;

    const d = t1 - t2;
    const sd = Math.sin(d);
    const cd = Math.cos(d);
    const denom = m1 + m2 * sd * sd;

    const alpha1 =
      (m2 * g * Math.sin(t2) * cd - m2 * sd * (l1 * w1 * w1 * cd + l2 * w2 * w2) - (m1 + m2) * g * Math.sin(t1)) /
      (l1 * denom);

    const alpha2 =
      ((m1 + m2) * (l1 * w1 * w1 * sd - g * Math.sin(t2) + g * Math.sin(t1) * cd) + m2 * l2 * w2 * w2 * sd * cd) /
      (l2 * denom);

    out[0] = w1;
    out[1] = alpha1;
    out[2] = w2;
    out[3] = alpha2;
  }
}

function addScaled(base: Float64Array, delta: Float64Array, scale: number, out: Float64Array): void {
  for (let i = 0; i < 4; i += 1) {
    out[i] = (base[i] as number) + (delta[i] as number) * scale;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
