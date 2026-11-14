/**
 * 渲染桥：把 3D 世界坐标翻译成屏幕坐标，供 UI 层画血条 / 图标 / 名字。
 *
 * ## 为什么不直接用 `Vector3.project(camera)`
 *
 * 三个理由，每个都会在真机上变成 bug：
 *
 * 1. **遮挡**。`project()` 只做数学投影，被楼挡住的敌人血条照样画在楼前面。
 *    血条穿墙是 3D UI 最经典的穿帮。
 * 2. **视锥**。相机背后的点投影出来是镜像的（`w < 0`），不裁剪会出现
 *    「血条跑到屏幕另一侧」。
 * 3. **重叠**。20 个血条挤在一起就没法读了，需要按优先级去重叠。
 *
 * 还有一个工程理由：这个模块**不 import three**。矩阵乘法自己算（16 个乘加），
 * 于是投影逻辑可以在纯 Node 里测 —— 而 `THREE.PerspectiveCamera` 需要能跑
 * `updateMatrixWorld`，在无 DOM 环境里虽然也行，但会把 three 的版本问题带进测试。
 *
 * ## 矩阵约定
 *
 * 列主序（与 WebGL / three 的 `Matrix4.elements` 一致），长度 16：
 * ```
 * m[0] m[4] m[8]  m[12]
 * m[1] m[5] m[9]  m[13]
 * m[2] m[6] m[10] m[14]
 * m[3] m[7] m[11] m[15]
 * ```
 */

export interface BridgeLabel {
  readonly id: string;
  /** 世界坐标。血条一般挂在「头顶」而不是原点。 */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 分组标签，UI 可据此选样式（`enemy` / `building` / `item`）。 */
  readonly kind?: string;
  /**
   * 优先级。重叠时大的留下，相同则按 `id` 字典序（**不能用插入序**，
   * 否则同一帧内 label 的增删顺序会改变谁显示谁不显示）。
   */
  readonly priority?: number;
  /** 超过这个距离就不显示（米）。默认不限。 */
  readonly maxDistance?: number;
}

export interface ScreenLabel {
  readonly id: string;
  /** CSS 像素，相对视口左上角。 */
  readonly x: number;
  readonly y: number;
  /** 相机到该点的距离（米）。 */
  readonly distance: number;
  /** NDC 深度，0 = 近平面。用于和 2D 图层的其它元素排序。 */
  readonly depth: number;
  /** 透视缩放，可直接乘字号（近大远小）。 */
  readonly scale: number;
  /** 是否被遮挡（不显示，但仍在结果里，方便调试与淡出动画）。 */
  readonly occluded: boolean;
  /** 最终是否应该画出来（在视锥内 且 未遮挡 且 通过去重叠）。 */
  readonly visible: boolean;
}

export interface OccluderBox {
  /** AABB，世界坐标。 */
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface CameraMatrices {
  /** 列主序 4×4 投影矩阵。 */
  readonly projection: ArrayLike<number>;
  /**
   * 列主序 4×4 视图矩阵（世界 → 视图），即 three 的 `camera.matrixWorldInverse`。
   *
   * **注意方向**：要的是 `matrixWorldInverse` 而不是 `matrixWorld`。
   * 传错了不会报错，画面也不炸 —— 远处的血条会以相机为圆心里外翻转，
   * 这类 bug 只有把相机移到物体背面才会显形。
   */
  readonly view: ArrayLike<number>;
  /** 相机世界坐标。遮挡射线要用；从矩阵反解也行，但显式传更省事也更准。 */
  readonly eye: { readonly x: number; readonly y: number; readonly z: number };
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface RenderBridgeOptions {
  /**
   * 屏幕上去重叠的最小间距（CSS 像素）。
   *
   * 44 与热区一致：低于 44 的两个图标即使不重叠，手指也点不准其中一个。
   */
  readonly minSeparation?: number;
  /** 遮挡判定的容差（米）。太小会让「贴在墙面的标签」被自己挡住。 */
  readonly occlusionBias?: number;
  /** 一次 update 最多保留多少个可见标签，防止极端情况爆量。 */
  readonly maxVisible?: number;
}

/** 列主序 4×4 相乘：`out = a × b`。 */
export function multiplyMatrix(out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[c * 4] as number;
    const b1 = b[c * 4 + 1] as number;
    const b2 = b[c * 4 + 2] as number;
    const b3 = b[c * 4 + 3] as number;
    out[c * 4] = (a[0] as number) * b0 + (a[4] as number) * b1 + (a[8] as number) * b2 + (a[12] as number) * b3;
    out[c * 4 + 1] = (a[1] as number) * b0 + (a[5] as number) * b1 + (a[9] as number) * b2 + (a[13] as number) * b3;
    out[c * 4 + 2] = (a[2] as number) * b0 + (a[6] as number) * b1 + (a[10] as number) * b2 + (a[14] as number) * b3;
    out[c * 4 + 3] = (a[3] as number) * b0 + (a[7] as number) * b1 + (a[11] as number) * b2 + (a[15] as number) * b3;
  }
}

export interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly w: number;
  readonly inFrustum: boolean;
}

/** 单个点投影。`vp` 是 投影 × 视图逆 的列主序矩阵。 */
export function projectPoint(
  vp: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  viewport: Viewport,
): ProjectedPoint {
  const clipX = (vp[0] as number) * x + (vp[4] as number) * y + (vp[8] as number) * z + (vp[12] as number);
  const clipY = (vp[1] as number) * x + (vp[5] as number) * y + (vp[9] as number) * z + (vp[13] as number);
  const clipZ = (vp[2] as number) * x + (vp[6] as number) * y + (vp[10] as number) * z + (vp[14] as number);
  const w = (vp[3] as number) * x + (vp[7] as number) * y + (vp[11] as number) * z + (vp[15] as number);

  // w <= 0 表示点在相机平面上或背后。不单独处理的话，除负 w 会把点「翻」到屏幕另一侧，
  // 表现为血条在身后出现并左右乱跳。
  if (w <= 1e-6) {
    return { x: 0, y: 0, depth: 1, w, inFrustum: false };
  }
  const ndcX = clipX / w;
  const ndcY = clipY / w;
  const ndcZ = clipZ / w;
  return {
    x: (ndcX * 0.5 + 0.5) * viewport.width,
    // NDC 的 y 向上，屏幕坐标向下，必须翻转；忘了翻会让所有 UI 上下颠倒
    y: (0.5 - ndcY * 0.5) * viewport.height,
    depth: ndcZ,
    w,
    inFrustum: ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && ndcZ >= -1 && ndcZ <= 1,
  };
}

/**
 * 射线与 AABB 求交（slab 法），返回近交点参数 t ∈ [0, maxT]，无交返回 -1。
 *
 * 方向必须是**单位向量**，`maxT` 给线段长度（米）。于是返回值 t 就是「走了多少米」，
 * `t < maxT` 即「在到达目标之前就撞上了」。
 * 早期版本把 tMax 写死成 1，等于只检查了 1 米内的遮挡 —— 远处标签一律不遮挡，
 * 症状是「走进了楼里，血条还在外面飘」。
 */
export function rayBoxHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: OccluderBox,
  maxT = 1,
): number {
  let tMin = 0;
  let tMax = maxT;
  const axes: readonly [number, number, number, number][] = [
    [ox, dx, box.minX, box.maxX],
    [oy, dy, box.minY, box.maxY],
    [oz, dz, box.minZ, box.maxZ],
  ];
  for (const [origin, dir, min, max] of axes) {
    // |dir| 极小看作与轴平行：只要原点在 slab 内就通过，否则必然不相交
    if (Math.abs(dir) < 1e-9) {
      if (origin < min || origin > max) return -1;
      continue;
    }
    let t1 = (min - origin) / dir;
    let t2 = (max - origin) / dir;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  return tMin;
}

/**
 * 标签 → 屏幕坐标的桥。
 *
 * 每帧 `update()` 一次，结果数组**复用**（`labels` 是同一个数组对象），
 * 避免每帧给 GC 喂 20 个对象。
 */
export class RenderBridge {
  private readonly entries: BridgeLabel[] = [];
  private occluders: readonly OccluderBox[] = [];
  private readonly vp = new Float64Array(16);
  private readonly out: ScreenLabel[] = [];
  private readonly visibleFlags: boolean[] = [];
  private readonly minSeparation: number;
  private readonly occlusionBias: number;
  private readonly maxVisible: number;
  private occludedCount = 0;
  private frustumCulled = 0;

  constructor(options: RenderBridgeOptions = {}) {
    this.minSeparation = options.minSeparation ?? 44;
    this.occlusionBias = options.occlusionBias ?? 0.15;
    this.maxVisible = options.maxVisible ?? 64;
  }

  addLabel(label: BridgeLabel): void {
    const at = this.entries.findIndex((item) => item.id === label.id);
    if (at >= 0) this.entries[at] = label;
    else this.entries.push(label);
  }

  removeLabel(id: string): void {
    const at = this.entries.findIndex((item) => item.id === id);
    if (at >= 0) this.entries.splice(at, 1);
  }

  clearLabels(): void {
    this.entries.length = 0;
  }

  get labelCount(): number {
    return this.entries.length;
  }

  /** 遮挡体。每帧可以换（建筑增删），内部不复制，调用方自己保证生命周期。 */
  setOccluders(boxes: readonly OccluderBox[]): void {
    this.occluders = boxes;
  }

  /** 上一次 update 的统计，诊断面板用。 */
  get stats(): { readonly total: number; readonly visible: number; readonly occluded: number; readonly culled: number } {
    let visible = 0;
    for (let i = 0; i < this.out.length; i += 1) if (this.visibleFlags[i] === true) visible += 1;
    return { total: this.entries.length, visible, occluded: this.occludedCount, culled: this.frustumCulled };
  }

  /** 投影结果。**同一个数组对象**，每帧原地更新。 */
  get labels(): readonly ScreenLabel[] {
    return this.out;
  }

  update(camera: CameraMatrices, viewport: Viewport): readonly ScreenLabel[] {
    multiplyMatrix(this.vp, camera.projection, camera.view);

    this.out.length = 0;
    this.visibleFlags.length = 0;
    this.occludedCount = 0;
    this.frustumCulled = 0;

    const eye = camera.eye;
    const candidates: { label: BridgeLabel; screen: ScreenLabel; sortKey: number }[] = [];

    for (const label of this.entries) {
      const point = projectPoint(this.vp, label.x, label.y, label.z, viewport);
      const dx = label.x - eye.x;
      const dy = label.y - eye.y;
      const dz = label.z - eye.z;
      const distance = Math.hypot(dx, dy, dz);

      if (!point.inFrustum) {
        this.frustumCulled += 1;
        this.out.push({
          id: label.id,
          x: point.x,
          y: point.y,
          distance,
          depth: point.depth,
          scale: 1,
          occluded: false,
          visible: false,
        });
        this.visibleFlags.push(false);
        continue;
      }

      if (label.maxDistance !== undefined && distance > label.maxDistance) {
        this.frustumCulled += 1;
        this.out.push({
          id: label.id,
          x: point.x,
          y: point.y,
          distance,
          depth: point.depth,
          scale: 1,
          occluded: false,
          visible: false,
        });
        this.visibleFlags.push(false);
        continue;
      }

      // 遮挡：从眼睛往标签射一条线，看有没有东西挡在半路
      let occluded = false;
      if (distance > this.occlusionBias) {
        const inv = 1 / distance;
        for (const box of this.occluders) {
          const t = rayBoxHit(eye.x, eye.y, eye.z, dx * inv, dy * inv, dz * inv, box, distance);
          // 比「到标签的距离 - 容差」更近就撞上了。容差用来放过「标签贴在墙面上」的情况，
          // 否则靠墙的牌子永远不会显示。
          if (t >= 0 && t < distance - this.occlusionBias) {
            occluded = true;
            break;
          }
        }
      }
      if (occluded) this.occludedCount += 1;

      // 透视缩放：以 20 米为基准，最近不小于 0.6，最远不大于 1.4
      const scale = Math.min(1.4, Math.max(0.6, 20 / Math.max(1, distance)));
      const screen: ScreenLabel = {
        id: label.id,
        x: point.x,
        y: point.y,
        distance,
        depth: point.depth,
        scale,
        occluded,
        visible: !occluded,
      };
      candidates.push({
        label,
        screen,
        // 排序键：优先级高的先占位，其次离得近的
        sortKey: (label.priority ?? 0) * 1000 - distance,
      });
    }

    // 去重叠：按优先级从高到低贪心占位。
    // 不能按 id 或插入序排 —— 同一帧内 label 的增删顺序会改变谁被隐藏，
    // 那是「同一画面不同结果」的确定性事故（ADR-001）。
    candidates.sort((a, b) => {
      if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
      return a.screen.id < b.screen.id ? -1 : a.screen.id > b.screen.id ? 1 : 0;
    });

    const taken: { x: number; y: number }[] = [];
    const minSq = this.minSeparation * this.minSeparation;
    let accepted = 0;

    for (const candidate of candidates) {
      let visible = candidate.screen.visible;
      if (visible) {
        if (accepted >= this.maxVisible) {
          visible = false;
        } else {
          for (const spot of taken) {
            const ddx = spot.x - candidate.screen.x;
            const ddy = spot.y - candidate.screen.y;
            if (ddx * ddx + ddy * ddy < minSq) {
              visible = false;
              break;
            }
          }
        }
      }
      if (visible) {
        taken.push({ x: candidate.screen.x, y: candidate.screen.y });
        accepted += 1;
      }
      this.out.push({ ...candidate.screen, visible });
      this.visibleFlags.push(visible);
    }

    return this.out;
  }
}
