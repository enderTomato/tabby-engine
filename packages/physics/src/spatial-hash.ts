import type { Obstacle } from './types.js';

/**
 * 静态障碍物的均匀网格宽相位。
 *
 * 之前 `Ragdoll.collide` 对每个点直接遍历全部障碍盒，成本是
 * O(点 × 盒 × 迭代)。demo 里 9 点 × 9 盒 × 4 迭代 = 324 次/帧还能忍，
 * 但只要摆 50 个布娃娃 + 60 栋建筑就是 50 × 9 × 60 × 4 = 108000 次/帧，
 * 单这一项就能吃掉 8ms 预算。空间哈希把这部分压到常数级。
 *
 * 三个设计取舍：
 *
 * 1. **桶用链表（head + next + payload）而不是计数排序三趟。**
 *    计数排序要两趟算前缀和，桶数又随城市扩建变化，每次 rebuild 都要重算。
 *    链表只需一次遍历插入，且 rebuild 时只重置 head（fill -1）。
 *
 * 2. **一个盒子插入它覆盖的所有格子，查询结果因此可能重复，这里故意不去重。**
 *    推离操作是幂等的：点被推到盒外后，再次测试 `x > min.x && x < max.x` 直接不成立。
 *    去重要么用 Set（每帧分配，违反零分配约束），要么用标记数组（每帧清零，
 *    成本接近重复一次 AABB 测试）。重复更便宜。
 *
 * 3. **实例池满时降级为暴力遍历并置 `degraded`。**
 *    宁可慢，不可错 —— 漏一个盒子会让布娃娃穿墙，而穿墙这种 bug 在手机上
 *    极难复现。`degraded` 会出现在诊断面板里，让人知道该调 cellSize 了。
 *
 * 只处理静态障碍：本引擎的障碍物是建筑与挡板，位置不逐帧变化。
 * 如果以后要支持移动障碍，正确做法是重建网格而不是增量更新（建筑数量在几十量级）。
 */
export class ObstacleGrid {
  /** 网格边长（世界单位）。建议取「典型障碍物尺寸」的 1~2 倍。 */
  readonly cellSize: number;
  /** 实例池上限，超出即降级。 */
  private readonly maxInstances: number;

  private head: Int32Array = new Int32Array(0);
  private payload: Int32Array = new Int32Array(0);
  private next: Int32Array = new Int32Array(0);

  private nx = 0;
  private ny = 0;
  private nz = 0;
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private invCell = 1;

  private boxes: readonly Obstacle[] = [];
  private instanceCount = 0;
  private overflow = false;

  constructor(cellSize = 2, maxInstances = 32768) {
    this.cellSize = Math.max(0.25, cellSize);
    this.maxInstances = Math.max(1, Math.floor(maxInstances));
  }

  get cellCount(): number {
    return this.nx * this.ny * this.nz;
  }

  /** 实际插入的「盒 × 格」实例数。诊断用。 */
  get instances(): number {
    return this.instanceCount;
  }

  /** true 表示实例池溢出，查询已退化为暴力遍历。 */
  get degraded(): boolean {
    return this.overflow;
  }

  rebuild(boxes: readonly Obstacle[]): void {
    this.boxes = boxes;
    this.instanceCount = 0;
    this.overflow = false;

    if (boxes.length === 0) {
      this.nx = 0;
      this.ny = 0;
      this.nz = 0;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i] as Obstacle;
      if (b.min.x < minX) minX = b.min.x;
      if (b.min.y < minY) minY = b.min.y;
      if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.x > maxX) maxX = b.max.x;
      if (b.max.y > maxY) maxY = b.max.y;
      if (b.max.z > maxZ) maxZ = b.max.z;
    }

    // 外扩半格：落在包围盒边界上的点（比如贴着最左一栋楼的墙面）也要能查到
    const pad = this.cellSize * 0.5;
    this.ox = minX - pad;
    this.oy = minY - pad;
    this.oz = minZ - pad;
    this.invCell = 1 / this.cellSize;

    const nx = Math.max(1, Math.ceil((maxX + pad - this.ox) * this.invCell));
    const ny = Math.max(1, Math.ceil((maxY + pad - this.oy) * this.invCell));
    const nz = Math.max(1, Math.ceil((maxZ + pad - this.oz) * this.invCell));
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;

    const cellCount = nx * ny * nz;
    if (this.head.length < cellCount) this.head = new Int32Array(cellCount);
    this.head.fill(-1, 0, cellCount);

    outer: for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i] as Obstacle;
      const x0 = this.clampCell(this.cellX(b.min.x), nx);
      const x1 = this.clampCell(this.cellX(b.max.x), nx);
      const y0 = this.clampCell(this.cellY(b.min.y), ny);
      const y1 = this.clampCell(this.cellY(b.max.y), ny);
      const z0 = this.clampCell(this.cellZ(b.min.z), nz);
      const z1 = this.clampCell(this.cellZ(b.max.z), nz);
      for (let z = z0; z <= z1; z += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const rowBase = nx * (y + ny * z);
          for (let x = x0; x <= x1; x += 1) {
            if (this.instanceCount >= this.maxInstances) {
              this.overflow = true;
              break outer;
            }
            this.ensureCapacity(this.instanceCount + 1);
            const c = rowBase + x;
            this.payload[this.instanceCount] = i;
            this.next[this.instanceCount] = this.head[c] as number;
            this.head[c] = this.instanceCount;
            this.instanceCount += 1;
          }
        }
      }
    }
  }

  /**
   * 查询点所在格子的盒子候选，写入 `out`，返回写入数量。
   *
   * 返回的是**候选**，调用方仍需做精确 AABB 测试。结果可能重复（见类注释）。
   * `out` 写满即截断：宁可少算几个盒子，也不能越界写。
   */
  queryPoint(x: number, y: number, z: number, out: Int32Array): number {
    if (this.instanceCount === 0) return 0;

    if (this.overflow) {
      const n = Math.min(this.boxes.length, out.length);
      for (let i = 0; i < n; i += 1) out[i] = i;
      return n;
    }

    // 点在网格外 → 不可能落在任何盒子内（网格范围是盒子包围盒的外扩）
    if (
      x < this.ox ||
      y < this.oy ||
      z < this.oz ||
      x > this.ox + this.nx * this.cellSize ||
      y > this.oy + this.ny * this.cellSize ||
      z > this.oz + this.nz * this.cellSize
    ) {
      return 0;
    }

    const cx = this.clampCell(this.cellX(x), this.nx);
    const cy = this.clampCell(this.cellY(y), this.ny);
    const cz = this.clampCell(this.cellZ(z), this.nz);
    const c = cx + this.nx * (cy + this.ny * cz);

    let n = 0;
    let inst = this.head[c] as number;
    while (inst >= 0 && n < out.length) {
      out[n] = this.payload[inst] as number;
      n += 1;
      inst = this.next[inst] as number;
    }
    return n;
  }

  private ensureCapacity(need: number): void {
    if (need <= this.payload.length) return;
    let cap = this.payload.length === 0 ? 1024 : this.payload.length;
    while (cap < need) cap *= 2;
    if (cap > this.maxInstances) cap = this.maxInstances;
    const p = new Int32Array(cap);
    p.set(this.payload);
    const nx = new Int32Array(cap);
    nx.set(this.next);
    this.payload = p;
    this.next = nx;
  }

  private cellX(v: number): number {
    return Math.floor((v - this.ox) * this.invCell);
  }

  private cellY(v: number): number {
    return Math.floor((v - this.oy) * this.invCell);
  }

  private cellZ(v: number): number {
    return Math.floor((v - this.oz) * this.invCell);
  }

  private clampCell(c: number, size: number): number {
    if (c < 0) return 0;
    const last = size - 1;
    return c > last ? last : c;
  }
}
