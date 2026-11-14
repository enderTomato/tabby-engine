/**
 * 液体模拟层：高度场 + 通量交换（Kass 管道模型）。
 *
 * ## 为什么液体要分两层
 *
 * ADR-006 定的路线是「模拟层用低成本确定性方案，表现层用粒子」。
 * 之前只有表现层（`fluid.ts` 的 SPH-lite 粒子），能看不能用：
 *
 * - SPH 粒子没有「水位」概念，问不出「这片地淹了多深」；
 * - 粒子的运动依赖迭代次数，跨设备不完全一致，进不了存档；
 * - 180 个粒子的预算铺不满一个湖。
 *
 * 这一层解决「水有多少、流到哪、会不会淹」。粒子继续负责「水花溅起来好看」。
 *
 * ## 为什么用管道模型而不是浅水方程
 *
 * 浅水方程（Saint-Venant）需要解双曲守恒律，移动端单帧算不动 48×48 网格。
 * 管道模型本质是「每格 4 个通量累加器」的元胞自动机：
 *
 *     f += dt · g · A / l · (h_src - h_dst)     // 通量按水头差加速
 *     f 钳制到 [ -可用水量/4 , +可用水量/4 ]      // 不能一帧抽干
 *     h += dt · (Σ流入 - Σ流出) / A              // 深度按净通量更新
 *
 * 它不满足动量守恒，会低估流速、抹平激波 —— 但对「城市积水 / 农田灌溉 /
 * 河道涨落」这类玩法完全够用，而且**天然稳定、天然确定**：
 * 固定遍历顺序 + 只有加减乘除，跨设备逐位一致，可以直接进存档。
 *
 * ## 数值稳定的三道闸
 *
 * 1. **CFL 检查**：dt 超过 `cellSize / sqrt(g·maxDepth)` 时内部自动切子步。
 *    不切的话大 dt（后台切回来那一帧）会让水瞬间「炸」到全图。
 * 2. **通量钳制**：单格单步最多流出 1/4 的水，防止负水深。
 * 3. **负深度钳制**：浮点误差可能让深度变成 -1e-9，统一夹到 0，
 *    否则 `sqrt(负深度)` 会在下游渲染里变 NaN。
 */

export interface LiquidOptions {
  /** 网格左下角世界坐标（x, z）。 */
  readonly originX: number;
  readonly originZ: number;
  /** 单格边长（米）。建议 0.25~1。越小越精细，成本按面积平方增长。 */
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly gravity: number;
  /** 单格最大水深，超过即视为溢出（洪水告警阈值）。 */
  readonly maxDepth: number;
  /** 基底地表高度（米）。地形起伏由 `setTerrain` 覆盖。 */
  readonly baseHeight: number;
  /**
   * 通量阻尼 0~1。
   *
   * 1 表示不衰减（推荐）。小于 1 会让水变「粘稠」：通量每步乘这个系数，
   * 水位差恒定时会收敛到有限流速而不是加速 —— 适合做泥浆、糖浆。
   * 但注意它同时会削弱远处格子的水位传导，洪水蔓延会明显变慢。
   */
  readonly damping: number;
  /** 单步最大子步数（CFL 自动切分用）。 */
  readonly maxSubSteps: number;
}

export const DEFAULT_LIQUID: LiquidOptions = {
  originX: -12,
  originZ: -12,
  cellSize: 0.5,
  cols: 48,
  rows: 48,
  gravity: 9.8,
  maxDepth: 1.5,
  baseHeight: 0,
  damping: 1,
  maxSubSteps: 4,
};

export interface LiquidSource {
  readonly id: string;
  /** 世界坐标（米）。 */
  readonly x: number;
  readonly z: number;
  /** 每秒注入的体积（立方米/秒）。 */
  readonly rate: number;
}

/** 溢出/洪水回调载荷。 */
export interface LiquidOverflow {
  readonly cellIndex: number;
  readonly col: number;
  readonly row: number;
  readonly height: number;
  readonly volume: number;
}

/**
 * 高度场液体。
 *
 * 坐标系与物理世界一致：XZ 平面铺网格，Y 是深度方向。
 * 世界坐标 → 格索引是 `(x - originX) / cellSize`，越界返回空。
 */
export class LiquidSystem {
  readonly options: LiquidOptions;
  readonly cols: number;
  readonly rows: number;
  /** 每格水深（米），渲染层可直接读。 */
  readonly depth: Float32Array;
  /** 每格基底高度（米）。`setTerrain` 可以覆盖成真实地形。 */
  readonly terrain: Float32Array;
  /** 每格的通量累加器（4 向），内部使用。 */
  private readonly flux: Float32Array;

  private readonly sources: LiquidSource[] = [];
  private readonly sourceCols: number[] = [];
  private readonly sourceRows: number[] = [];

  /** 溢出回调。world 会把它转成 `liquidOverflow` 事件。 */
  onOverflow: ((overflow: LiquidOverflow) => void) | null = null;

  private lastStepMs = 0;
  private overflowCount = 0;

  constructor(options: Partial<LiquidOptions> = {}) {
    this.options = { ...DEFAULT_LIQUID, ...options };
    this.cols = Math.max(1, Math.floor(this.options.cols));
    this.rows = Math.max(1, Math.floor(this.options.rows));
    const n = this.cols * this.rows;
    this.depth = new Float32Array(n);
    this.terrain = new Float32Array(n);
    if (this.options.baseHeight !== 0) this.terrain.fill(this.options.baseHeight);
    this.flux = new Float32Array(n * 4);
  }

  get cellCount(): number {
    return this.cols * this.rows;
  }

  get lastStepDurationMs(): number {
    return this.lastStepMs;
  }

  /** 累计溢出次数，诊断用。 */
  get overflows(): number {
    return this.overflowCount;
  }

  /** 单格总水量（立方米）。 */
  get totalVolume(): number {
    let sum = 0;
    for (let i = 0; i < this.depth.length; i += 1) sum += this.depth[i] as number;
    return sum * this.options.cellSize * this.options.cellSize;
  }

  // ───────────────────────── 地形与查询 ─────────────────────────

  /**
   * 设置基底地形高度。
   *
   * 地形是液体的边界条件：水往低处流、水面高度 = 地形 + 水深。
   * 传 `null` 恢复成统一的 `baseHeight`。
   *
   * 传进来的 `heights` 必须与网格同尺寸（cols × rows，行优先）。
   */
  setTerrain(heights: Float32Array | null): void {
    if (heights === null) {
      this.terrain.fill(this.options.baseHeight);
      return;
    }
    if (heights.length !== this.cellCount) {
      throw new Error(`[tabby/physics] 地形尺寸不符：需要 ${this.cellCount}，收到 ${heights.length}`);
    }
    this.terrain.set(heights);
  }

  /** 世界坐标 → 格索引，越界返回 -1。 */
  indexAt(x: number, z: number): number {
    const col = Math.floor((x - this.options.originX) / this.options.cellSize);
    const row = Math.floor((z - this.options.originZ) / this.options.cellSize);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  /** 某点水深（米）。越界返回 0。 */
  getHeightAt(x: number, z: number): number {
    const i = this.indexAt(x, z);
    return i < 0 ? 0 : (this.depth[i] as number);
  }

  /** 某点水面绝对高度（地形 + 水深）。渲染与洪水判定都用这个。 */
  getSurfaceAt(x: number, z: number): number {
    const i = this.indexAt(x, z);
    if (i < 0) return 0;
    return (this.terrain[i] as number) + (this.depth[i] as number);
  }

  // ───────────────────────── 水源 ─────────────────────────

  addSource(source: LiquidSource): void {
    const i = this.indexAt(source.x, source.z);
    if (i < 0) throw new Error(`[tabby/physics] 水源超出网格：(${source.x}, ${source.z})`);
    const existing = this.sources.findIndex((s) => s.id === source.id);
    if (existing >= 0) {
      this.sources.splice(existing, 1);
      this.sourceCols.splice(existing, 1);
      this.sourceRows.splice(existing, 1);
    }
    this.sources.push(source);
    this.sourceCols.push(i % this.cols);
    this.sourceRows.push(Math.floor(i / this.cols));
  }

  removeSource(id: string): boolean {
    const at = this.sources.findIndex((s) => s.id === id);
    if (at < 0) return false;
    this.sources.splice(at, 1);
    this.sourceCols.splice(at, 1);
    this.sourceRows.splice(at, 1);
    return true;
  }

  /** 改某个水源的流量（立方米/秒）。常用于水阀开关。 */
  setFlowRate(id: string, rate: number): boolean {
    const at = this.sources.findIndex((s) => s.id === id);
    if (at < 0) return false;
    const old = this.sources[at] as LiquidSource;
    this.sources[at] = { id: old.id, x: old.x, z: old.z, rate: Math.max(0, rate) };
    return true;
  }

  getSources(): readonly LiquidSource[] {
    return this.sources;
  }

  // ───────────────────────── 步进 ─────────────────────────

  /**
   * CFL 上界：一步之内水面扰动不应跨越超过一格。
   *
   * `dt_max = l / sqrt(g · h_max)`。超过它，管道模型会出现负水深与振荡
   * （水在相邻两格之间来回弹，永远停不下来）。
   */
  cflLimit(): number {
    let deepest = 0;
    for (let i = 0; i < this.depth.length; i += 1) {
      const d = this.depth[i] as number;
      if (d > deepest) deepest = d;
    }
    if (deepest <= 1e-6) return Infinity;
    return this.options.cellSize / Math.sqrt(this.options.gravity * deepest);
  }

  step(dt: number): void {
    const t0 = now();
    const limit = this.cflLimit();
    let subSteps = 1;
    if (Number.isFinite(limit) && dt > limit) {
      subSteps = Math.min(this.options.maxSubSteps, Math.ceil(dt / limit));
    }
    const h = dt / subSteps;
    for (let s = 0; s < subSteps; s += 1) {
      this.applySources(h);
      this.simulate(h);
    }
    this.lastStepMs = now() - t0;
  }

  /** 水源按流量注水。放在子步内执行，避免大 dt 时一次性灌满一格。 */
  private applySources(h: number): void {
    if (this.sources.length === 0) return;
    const area = this.options.cellSize * this.options.cellSize;
    for (let s = 0; s < this.sources.length; s += 1) {
      const source = this.sources[s] as LiquidSource;
      if (source.rate <= 0) continue;
      const col = this.sourceCols[s] as number;
      const row = this.sourceRows[s] as number;
      // 水源注入的是一格的水，但视觉上要「摊开」一点才不会像个喷泉柱
      const share = (source.rate * h) / area;
      this.addWater(row * this.cols + col, share * 0.6);
      if (col > 0) this.addWater(row * this.cols + col - 1, share * 0.15);
      if (col + 1 < this.cols) this.addWater(row * this.cols + col + 1, share * 0.15);
      if (row > 0) this.addWater((row - 1) * this.cols + col, share * 0.05);
      if (row + 1 < this.rows) this.addWater((row + 1) * this.cols + col, share * 0.05);
    }
  }

  private addWater(index: number, amount: number): void {
    if (index < 0 || index >= this.depth.length || amount <= 0) return;
    this.depth[index] = (this.depth[index] as number) + amount;
  }

  /**
   * 一步通量交换（交错网格）。
   *
   * **每对相邻格只有一条通量**，存在左侧/上侧格子的槽位里：
   *
   *     flux[i*4 + 0]  = i → (col+1) 方向
   *     flux[i*4 + 2]  = i → (row+1) 方向
   *
   * 深度更新时，i 的流入来自 `flux[i-1]` 与 `flux[i-cols]`，流出是自己的两条。
   * 这样同一个数在两侧一正一负，**总水量严格守恒**。
   *
   * 为什么不用「每格 4 个独立通量」（初版写法）：
   * 那样 f(i→j) 与 f(j→i) 是两个累加器，各自 evolution、各自按自己的水量 clamp，
   * 一旦两者不对称，水就凭空多出来或消失。实测 5 秒后总量掉了 99.9%。
   * 而且它还需要双方各自记账，漏一边就是漏一半的水。
   *
   * 遍历顺序固定（行优先），不依赖任何容器序 —— 确定性红线。
   */
  private simulate(dt: number): void {
    if (dt <= 0) return;
    const { cellSize, gravity, damping, maxDepth } = this.options;
    const cols = this.cols;
    const rows = this.rows;
    const area = cellSize * cellSize;
    const depth = this.depth;
    const terrain = this.terrain;
    const flux = this.flux;
    const gain = (dt * gravity * area) / cellSize;
    const invDt = 1 / dt;
    // 单对通量最保守的上限：源格单步最多流出 1/4 的水（4 个方向均分）
    const flowLimit = (area * invDt) / 4;

    // ① 更新通量（只算 +x 与 +z，另一半由镜像引用）
    for (let row = 0; row < rows; row += 1) {
      const rowBase = row * cols;
      for (let col = 0; col < cols; col += 1) {
        const i = rowBase + col;
        const hi = depth[i] as number;
        const surface = (terrain[i] as number) + hi;
        const cap = hi * flowLimit;

        const xSlot = i * 4;
        if (col + 1 < cols) {
          const j = i + 1;
          const hj = depth[j] as number;
          const d = surface - ((terrain[j] as number) + hj);
          let f = ((flux[xSlot] as number) + gain * d) * damping;
          // 限流必须按「流出方」的水量算。全用本格水量限制的话，
          // 当邻居比我更浅时（hj < hi），会允许它流出超过自身存量的水，
          // 于是邻居变成负深度被钳到 0 —— 那部分水就凭空消失了。
          const capIn = hj * flowLimit;
          if (f > cap) f = cap;
          else if (f < -capIn) f = -capIn;
          flux[xSlot] = f;
        } else {
          flux[xSlot] = 0;
        }

        const zSlot = i * 4 + 2;
        if (row + 1 < rows) {
          const j = i + cols;
          const hj = depth[j] as number;
          const d = surface - ((terrain[j] as number) + hj);
          let f = ((flux[zSlot] as number) + gain * d) * damping;
          const capIn = hj * flowLimit;
          if (f > cap) f = cap;
          else if (f < -capIn) f = -capIn;
          flux[zSlot] = f;
        } else {
          flux[zSlot] = 0;
        }
      }
    }

    // ② 按净通量更新深度（流入 - 流出）
    const scale = dt / area;
    for (let row = 0; row < rows; row += 1) {
      const rowBase = row * cols;
      for (let col = 0; col < cols; col += 1) {
        const i = rowBase + col;
        const slot = i * 4;
        const outX = flux[slot] as number;
        const outZ = flux[slot + 2] as number;
        const inX = col > 0 ? (flux[(i - 1) * 4] as number) : 0;
        const inZ = row > 0 ? (flux[(i - cols) * 4 + 2] as number) : 0;
        depth[i] = (depth[i] as number) + (inX + inZ - outX - outZ) * scale;
      }
    }

    // ③ 负深度钳制 + 溢流检测
    for (let i = 0; i < depth.length; i += 1) {
      const d = depth[i] as number;
      if (d < 0) {
        depth[i] = 0;
        continue;
      }
      if (d > maxDepth) {
        depth[i] = maxDepth;
        this.overflowCount += 1;
        if (this.onOverflow !== null) {
          this.onOverflow({
            cellIndex: i,
            col: i % cols,
            row: Math.floor(i / cols),
            height: (terrain[i] as number) + maxDepth,
            volume: (d - maxDepth) * area,
          });
        }
      }
    }
  }

  // ───────────────────────── 存档 ─────────────────────────

  /**
   * 序列化水深场。
   *
   * 用 Uint16 归一化到 [0, maxDepth]：48×48 网格是 4608 字节，
   * 换成 Float32 要 9216 字节。精度上 1.5 / 65535 ≈ 0.00002 米，
   * 比渲染能表现的精度还细，没有必要用浮点。
   *
   * 通量**不存**：它是瞬时量，读档后从 0 开始，一两秒内会自然恢复到平衡态。
   * 存它反而会让读档瞬间多出一股莫名的水流。
   */
  serialize(): Uint8Array {
    const n = this.cellCount;
    const out = new Uint8Array(n * 2);
    const scale = 65535 / this.options.maxDepth;
    for (let i = 0; i < n; i += 1) {
      const v = Math.max(0, Math.min(65535, Math.round((this.depth[i] as number) * scale)));
      out[i * 2] = v & 0xff;
      out[i * 2 + 1] = (v >> 8) & 0xff;
    }
    return out;
  }

  deserialize(data: Uint8Array): void {
    const n = this.cellCount;
    if (data.length !== n * 2) {
      throw new Error(`[tabby/physics] 液面存档长度不符：需要 ${n * 2}，收到 ${data.length}`);
    }
    const scale = this.options.maxDepth / 65535;
    for (let i = 0; i < n; i += 1) {
      const lo = data[i * 2] as number;
      const hi = data[i * 2 + 1] as number;
      this.depth[i] = ((hi << 8) | lo) * scale;
    }
    this.flux.fill(0);
  }

  clear(): void {
    this.depth.fill(0);
    this.flux.fill(0);
    this.overflowCount = 0;
  }

  /** 直接灌满网格，用于洪水测试或调试。 */
  fillDepth(meters: number): void {
    this.depth.fill(Math.max(0, Math.min(this.options.maxDepth, meters)));
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
