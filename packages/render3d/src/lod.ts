/**
 * 建筑 LOD 的分类逻辑。
 *
 * 单独抽出来是为了能在 Node 里测：这里出错的代价是**建筑闪烁** ——
 * 站在分界线附近左右挪一步，建筑就在「方盒」和「贴片」之间来回切，
 * 比干脆不分 LOD 还难看。而这类问题在单元测试里能一眼抓住，在真机上
 * 只能靠盯着屏幕看半天。
 *
 * ## 三条规则
 *
 * 1. **迟滞**：进入近景的阈值比退出的小（`enterNear < exitNear`）。
 *    只有一个阈值时，距离在它上下抖动就会反复切换。
 * 2. **遍历序固定**：按实例下标顺序分类，输出数组也按这个顺序写。
 *    不依赖 Map/Set 遍历序（确定性红线）。
 * 3. **不分配**：结果写进调用方的 Int32Array，每帧调用也不产生垃圾。
 */

export interface LodSplit {
  /** 走实例化方盒的实例数。 */
  readonly near: number;
  /** 走 billboard 贴片的实例数。 */
  readonly far: number;
  /** 超出绘制距离、直接不画的数量。 */
  readonly culled: number;
}

export interface LodThresholds {
  /** 小于它就从贴片升回方盒（米）。 */
  readonly enterNear: number;
  /** 大于它就退回贴片（米）。 */
  readonly exitNear: number;
  /** 超过它直接不画（米）。雾已经把更远的东西盖掉了，再画纯属浪费。 */
  readonly maxDistance: number;
}

/**
 * 按距离把实例分成三组。
 *
 * `points` 是扁平的 `[x0,z0, x1,z1, ...]`；`states` 是跨帧保留的 0/1 标记
 * （1 = 上一帧是近景），本函数会原地更新它。
 *
 * 返回的下标数组长度一定等于 `count`（用 `lodSplit.near` / `.far` 取有效长度），
 * 这样调用方可以复用同一块内存。
 */
export function classifyLod(
  points: Float32Array,
  states: Uint8Array,
  count: number,
  cameraX: number,
  cameraZ: number,
  thresholds: LodThresholds,
  nearIndex: Int32Array,
  farIndex: Int32Array,
): LodSplit {
  const enterSq = thresholds.enterNear * thresholds.enterNear;
  const exitSq = thresholds.exitNear * thresholds.exitNear;
  const cullSq = thresholds.maxDistance * thresholds.maxDistance;

  let near = 0;
  let far = 0;
  let culled = 0;

  for (let i = 0; i < count; i += 1) {
    const dx = (points[i * 2] as number) - cameraX;
    const dz = (points[i * 2 + 1] as number) - cameraZ;
    const distanceSq = dx * dx + dz * dz;

    if (distanceSq > cullSq) {
      culled += 1;
      states[i] = 0;
      continue;
    }

    const wasNear = states[i] === 1;
    // 迟滞：已经在近景的用更宽的退出阈值，否则用更窄的进入阈值
    const isNear = wasNear ? distanceSq <= exitSq : distanceSq <= enterSq;
    states[i] = isNear ? 1 : 0;

    if (isNear) {
      nearIndex[near] = i;
      near += 1;
    } else {
      farIndex[far] = i;
      far += 1;
    }
  }

  return { near, far, culled };
}
