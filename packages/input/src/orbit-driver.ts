/**
 * 轨道相机状态机：旋转 / 缩放 / 平移 + 阻尼惯性。
 *
 * **纯数学，不 import three**。渲染包拿它的输出自己拼矩阵 —— 这样惯性曲线可以在
 * 纯 Node 里测（`node --test`），不需要 WebGL 上下文。
 *
 * ## 为什么惯性要按 `exp(-k·dt)` 衰减而不是 `v -= k·dt`
 *
 * 线性衰减（`v -= k*dt`）在低帧率下会在几帧内把速度减到 0，在高帧率下要几十帧 ——
 * 同一个手感在 30fps 和 120fps 设备上完全不同。指数衰减的**每一帧衰减比例**
 * 只由时长决定，与帧数无关：
 *
 * ```
 * v(t) = v0 · exp(-k·t)
 * ```
 *
 * 于是 30fps 上滑一次和 120fps 上滑一次，松手后转过的角度一致。
 * 这是「碎片化设备上体验一致」这类需求里最容易被忽略的一环。
 */

/** 惯性衰减系数（1/毫秒）。0.004 对应「松手后约 0.6 秒停下」。 */
export const DEFAULT_DAMPING = 0.004;

/** 速度低于此值直接归零（像素/毫秒）。不归零会永久拖着一个极小的尾巴。 */
export const INERTIA_EPSILON = 0.0008;

export interface OrbitDriverOptions {
  readonly theta?: number;
  readonly phi?: number;
  readonly distance?: number;
  readonly minPhi?: number;
  readonly maxPhi?: number;
  readonly minDistance?: number;
  readonly maxDistance?: number;
  /** 1/毫秒。 */
  readonly damping?: number;
  /** 拖拽灵敏度（弧度/像素）。 */
  readonly rotateSpeed?: number;
  /** 双指旋转灵敏度。 */
  readonly twistSpeed?: number;
  /** 滚轮缩放灵敏度（每像素改变多少距离）。 */
  readonly zoomSpeed?: number;
}

export interface OrbitState {
  /** 水平角（弧度）。 */
  readonly theta: number;
  /** 极角（弧度），0 = 正上方。 */
  readonly phi: number;
  readonly distance: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly targetZ: number;
}

const PHI_MIN = 0.25;
const PHI_MAX = 1.45;

export class OrbitDriver {
  private theta: number;
  private phi: number;
  private distance: number;
  private targetX = 0;
  private targetY = 0;
  private targetZ = 0;

  private readonly minPhi: number;
  private readonly maxPhi: number;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly damping: number;
  private readonly rotateSpeed: number;
  private readonly twistSpeed: number;
  private readonly zoomSpeed: number;

  /** 角速度（弧度/毫秒），惯性用。 */
  private vTheta = 0;
  private vPhi = 0;

  constructor(options: OrbitDriverOptions = {}) {
    this.theta = options.theta ?? -0.7;
    this.phi = options.phi ?? 1.02;
    this.distance = options.distance ?? 24;
    this.minPhi = options.minPhi ?? PHI_MIN;
    this.maxPhi = options.maxPhi ?? PHI_MAX;
    this.minDistance = options.minDistance ?? 8;
    this.maxDistance = options.maxDistance ?? 60;
    this.damping = Math.max(1e-6, options.damping ?? DEFAULT_DAMPING);
    this.rotateSpeed = options.rotateSpeed ?? 0.006;
    this.twistSpeed = options.twistSpeed ?? 0.8;
    this.zoomSpeed = options.zoomSpeed ?? 0.02;
  }

  get state(): OrbitState {
    return {
      theta: this.theta,
      phi: this.phi,
      distance: this.distance,
      targetX: this.targetX,
      targetY: this.targetY,
      targetZ: this.targetZ,
    };
  }

  /** 是否还在惯性滑动。UI 可据此决定要不要继续要帧。 */
  get isSettling(): boolean {
    return Math.abs(this.vTheta) > INERTIA_EPSILON || Math.abs(this.vPhi) > INERTIA_EPSILON;
  }

  /** 单指拖拽（像素位移）。松手时把最后一帧的速度交给 `release()` 开惯性。 */
  drag(dx: number, dy: number): void {
    this.theta -= dx * this.rotateSpeed;
    this.phi = clamp(this.phi - dy * this.rotateSpeed * 0.85, this.minPhi, this.maxPhi);
  }

  /** 松手：带上速度开惯性。`vx/vy` 单位是像素/毫秒。 */
  release(vx: number, vy: number): void {
    this.vTheta = -vx * this.rotateSpeed;
    this.vPhi = -vy * this.rotateSpeed * 0.85;
    // 已经被钳到边界的轴不该继续积累速度，否则"顶天"之后还会反弹
    if (this.phi <= this.minPhi + 1e-4 || this.phi >= this.maxPhi - 1e-4) this.vPhi = 0;
  }

  /** 立刻停住惯性（再次按下时调用）。 */
  stop(): void {
    this.vTheta = 0;
    this.vPhi = 0;
  }

  /**
   * 双指捏合。`scale` 是相对起始的比值（1 = 没变）。
   *
   * 用比值而不是增量：增量累乘会漂移，捏 100 次之后距离会跑偏几个百分点。
   */
  pinch(scale: number, baseDistance: number): void {
    if (!(scale > 0)) return;
    this.distance = clamp(baseDistance / scale, this.minDistance, this.maxDistance);
  }

  /** 双指扭转（弧度）。 */
  twist(deltaAngle: number): void {
    this.theta -= deltaAngle * this.twistSpeed;
  }

  /** 双指平移：把目标点沿屏幕平面移动。 */
  pan(dx: number, dy: number, worldPerPixel = 0.02): void {
    // 屏幕右 = 世界 +x 的方向取决于当前 theta，所以按角度分解
    const cos = Math.cos(this.theta);
    const sin = Math.sin(this.theta);
    const scale = worldPerPixel * (this.distance / 24);
    this.targetX -= (dx * cos - dy * sin) * scale;
    this.targetZ += (dx * sin + dy * cos) * scale;
  }

  /** 滚轮缩放。`deltaY` 是归一化后的像素量，向下滚 = 拉远。 */
  wheel(deltaY: number): void {
    this.distance = clamp(this.distance + deltaY * this.zoomSpeed, this.minDistance, this.maxDistance);
  }

  /** 直接设置（过场动画、读档恢复视角）。 */
  set(next: Partial<OrbitState>): void {
    if (next.theta !== undefined) this.theta = next.theta;
    if (next.phi !== undefined) this.phi = clamp(next.phi, this.minPhi, this.maxPhi);
    if (next.distance !== undefined) this.distance = clamp(next.distance, this.minDistance, this.maxDistance);
    if (next.targetX !== undefined) this.targetX = next.targetX;
    if (next.targetY !== undefined) this.targetY = next.targetY;
    if (next.targetZ !== undefined) this.targetZ = next.targetZ;
  }

  /**
   * 推进一帧。返回是否还在动（false 表示彻底停下，可以不再请求帧）。
   *
   * `dtMs` 必须来自真实时间差，不能用固定 16.67 —— 否则在 30fps 的设备上惯性会慢一倍。
   */
  update(dtMs: number): boolean {
    if (!this.isSettling) return false;
    const dt = Math.max(0, Math.min(dtMs, 100)); // 切后台回来时 dt 可能是几秒，封顶
    const decay = Math.exp(-this.damping * dt);

    // 位移必须用**指数衰减的解析积分**：v(t) = v0·e^(-k·t)，
    // 则 ∫v dt = v0·(1 - e^(-k·dt)) / k。
    // 直接用 `v * dt` 是分段常数近似，帧率越低误差越大 ——
    // 30fps 与 60fps 会转出不同的角度，正是「不同机型手感不同」的来源。
    const travel = (1 - decay) / this.damping;
    this.theta += this.vTheta * travel;
    this.phi = clamp(this.phi + this.vPhi * travel, this.minPhi, this.maxPhi);

    this.vTheta *= decay;
    this.vPhi *= decay;
    if (Math.abs(this.vTheta) <= INERTIA_EPSILON) this.vTheta = 0;
    if (Math.abs(this.vPhi) <= INERTIA_EPSILON) this.vPhi = 0;
    return this.isSettling;
  }

  /** 相机位置（不依赖 three，交给渲染层拼矩阵）。 */
  eye(): { readonly x: number; readonly y: number; readonly z: number } {
    const sinPhi = Math.sin(this.phi);
    return {
      x: this.targetX + this.distance * sinPhi * Math.sin(this.theta),
      y: this.targetY + this.distance * Math.cos(this.phi),
      z: this.targetZ + this.distance * sinPhi * Math.cos(this.theta),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
