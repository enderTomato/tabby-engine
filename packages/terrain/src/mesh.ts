import type { HeightField } from './height-field.js';

/**
 * 地形分块网格生成。
 *
 * ## 为什么用 CPU 分块网格而不是顶点着色器位移
 *
 * 顶点着色器采样高度图（零 CPU）看起来很美，但三个硬伤：
 * 1. **物理对不上**：物理查询在 CPU 侧读 HeightField，而 GPU 侧的顶点位置由
 *    纹理采样决定，两者用不同的插值方式，坡面上会看到布娃娃半陷进地面。
 * 2. **LOD 裂缝无法用 skirt 修**：skirt 需要知道边界顶点的高度，着色器方案里
 *    这个值在 CPU 侧不存在。
 * 3. **无法做挖填方**：编辑后要重传纹理，重传成本比重建一个 33×33 的网格还高。
 *
 * 分块 + 四叉树 LOD 的取舍见 ADR-008。这里的实现给「块」这一层：
 * 调用方负责决定哪些块可见、用哪一级 LOD。
 *
 * ## 顶点排布
 *
 *     x = 0 ─────────── x = N
 *     ┌────┬────┬──── ... ┐    每块 (N+1)² 个地形顶点
 *     │  · │  · │         │    外加四条边各 (N+1) 个裙边顶点
 *     └────┴────┴──── ... ┘
 *
 * 边界顶点**与相邻块共用同一世界坐标**（`col = cx*N + x*step`），所以同级 LOD
 * 的相邻块天然无缝。只有 LOD 不同时才靠 skirt 遮住裂缝。
 */

export interface ChunkMeshOptions {
  /** 每块的格子数（顶点数 = chunkSize + 1）。建议 32，默认 32。 */
  readonly chunkSize: number;
  /** 采样步长：1 为原始精度，2 隔点取，4 再隔一倍。 */
  readonly lodStep: number;
  /** 垂直夸张系数，与 meta.verticalScale 一致。 */
  readonly verticalScale: number;
  /**
   * 裙边下垂深度（米）。0 表示不生成裙边。
   *
   * 取「该块最大高差的 1~2 倍」比较合适：太浅遮不住 LOD 裂缝，
   * 太深会在远景出现一层明显的暗色墙。
   */
  readonly skirtDepth: number;
}

export const DEFAULT_CHUNK_MESH: ChunkMeshOptions = {
  chunkSize: 32,
  lodStep: 1,
  verticalScale: 1,
  skirtDepth: 8,
};

export interface ChunkMesh {
  readonly cx: number;
  readonly cy: number;
  readonly lodStep: number;
  /** 顶点数据：x, y(高度), z。世界坐标，已应用垂直夸张。 */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** uv：u 向东、v 向南，范围 [0,1] 覆盖整图，供 splat 按世界坐标采样。 */
  readonly uvs: Float32Array;
  readonly indices: Uint16Array;
  readonly vertexCount: number;
  readonly indexCount: number;
  /** 该块的海拔范围（米，未乘 verticalScale），用于剔除与 LOD 选择。 */
  readonly minElevation: number;
  readonly maxElevation: number;
}

/**
 * 生成一块地形网格。
 *
 * 索引用 Uint16：块内顶点数 = (N+1)² + 4(N+1)。N=32 时 1221，余量充足。
 * 如果以后把 chunkSize 提到 128（16641 顶点）就会溢出 —— 届时要换 Uint32，
 * 这里显式检查并抛错，避免静默生成一张破面。
 */
export function buildChunkMesh(
  field: HeightField,
  cx: number,
  cy: number,
  options: Partial<ChunkMeshOptions> = {},
): ChunkMesh {
  const opts: ChunkMeshOptions = { ...DEFAULT_CHUNK_MESH, ...options };
  const n = Math.max(1, Math.floor(opts.chunkSize));
  const step = Math.max(1, Math.floor(opts.lodStep));
  const vs = opts.verticalScale;
  const skirt = Math.max(0, opts.skirtDepth);

  const gridVerts = (n + 1) * (n + 1);
  const dirtVerts = skirt > 0 ? 4 * (n + 1) : 0;
  const vertexCount = gridVerts + dirtVerts;
  if (vertexCount > 65535) {
    throw new Error(
      `[tabby/terrain] chunkSize=${n} 时顶点数 ${vertexCount} 超过 Uint16 索引上限，请减少 chunkSize 或改用 Uint32 索引`,
    );
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  let minElevation = Infinity;
  let maxElevation = -Infinity;

  // ── 地形顶点 ──
  for (let z = 0; z <= n; z += 1) {
    for (let x = 0; x <= n; x += 1) {
      const i = z * (n + 1) + x;
      const col = cx * n + x * step;
      const row = cy * n + z * step;
      const elevation = field.elevationAt(col, row);
      if (elevation < minElevation) minElevation = elevation;
      if (elevation > maxElevation) maxElevation = elevation;

      positions[i * 3] = col * field.cellSize;
      positions[i * 3 + 1] = elevation * vs;
      positions[i * 3 + 2] = row * field.cellSize;

      const normal = field.normalAt(col, row);
      normals[i * 3] = normal[0];
      normals[i * 3 + 1] = normal[1];
      normals[i * 3 + 2] = normal[2];

      uvs[i * 2] = field.width > 1 ? col / (field.width - 1) : 0;
      uvs[i * 2 + 1] = field.height > 1 ? row / (field.height - 1) : 0;
    }
  }

  // ── 裙边：沿四条边复制一圈顶点向下垂 ──
  if (dirtVerts > 0) {
    const depthY = skirt * vs;
    let w = gridVerts;
    const emitSkirt = (srcIndex: number): void => {
      positions[w * 3] = positions[srcIndex * 3] as number;
      positions[w * 3 + 1] = (positions[srcIndex * 3 + 1] as number) - depthY;
      positions[w * 3 + 2] = positions[srcIndex * 3 + 2] as number;
      normals[w * 3] = normals[srcIndex * 3] as number;
      normals[w * 3 + 1] = normals[srcIndex * 3 + 1] as number;
      normals[w * 3 + 2] = normals[srcIndex * 3 + 2] as number;
      uvs[w * 2] = uvs[srcIndex * 2] as number;
      uvs[w * 2 + 1] = uvs[srcIndex * 2 + 1] as number;
      w += 1;
    };
    // 北（+z 最小）、南、西、东，顺序固定以便索引可预测
    for (let x = 0; x <= n; x += 1) emitSkirt(x);
    for (let x = 0; x <= n; x += 1) emitSkirt(n * (n + 1) + x);
    for (let z = 0; z <= n; z += 1) emitSkirt(z * (n + 1));
    for (let z = 0; z <= n; z += 1) emitSkirt(z * (n + 1) + n);
  }

  // ── 索引 ──
  const quadCount = n * n;
  const skirtQuads = dirtVerts > 0 ? 4 * n : 0;
  const indexCount = quadCount * 6 + skirtQuads * 6;
  const indices = new Uint16Array(indexCount);
  let k = 0;

  for (let z = 0; z < n; z += 1) {
    for (let x = 0; x < n; x += 1) {
      const a = z * (n + 1) + x;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      // 逆时针（+Y 向上）：a→c→b 与 b→c→d
      indices[k] = a;
      indices[k + 1] = c;
      indices[k + 2] = b;
      indices[k + 3] = b;
      indices[k + 4] = c;
      indices[k + 5] = d;
      k += 6;
    }
  }

  if (dirtVerts > 0) {
    // 每条边的裙带：(地面点, 裙点) 组成四边形，朝向块外侧
    const sides: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    for (let s = 0; s < 4; s += 1) {
      const offset = s * (n + 1);
      const dir = (sides[s] as readonly [number, number])[0];
      for (let t = 0; t < n; t += 1) {
        const g0 = groundIndex(dir, t, n);
        const g1 = groundIndex(dir, t + 1, n);
        const d0 = gridVerts + offset + t;
        const d1 = gridVerts + offset + t + 1;
        // 两个三角形，绕序保证从外侧可见
        indices[k] = g0;
        indices[k + 1] = d0;
        indices[k + 2] = g1;
        indices[k + 3] = g1;
        indices[k + 4] = d0;
        indices[k + 5] = d1;
        k += 6;
      }
    }
  }

  return {
    cx,
    cy,
    lodStep: step,
    positions,
    normals,
    uvs,
    indices,
    vertexCount,
    indexCount: k,
    minElevation: Number.isFinite(minElevation) ? minElevation : 0,
    maxElevation: Number.isFinite(maxElevation) ? maxElevation : 0,
  };
}

/** 第 dir 条边上的第 t 个地面顶点索引（与裙边顶点顺序一致）。 */
function groundIndex(dir: number, t: number, n: number): number {
  if (dir === 0) return t;
  if (dir === 1) return n * (n + 1) + t;
  if (dir === 2) return t * (n + 1);
  return t * (n + 1) + n;
}

export interface LodSelectionOptions {
  /** chunkSize，用于换算块的世界尺寸。 */
  readonly chunkSize: number;
  readonly cellSize: number;
  /** 允许的最大屏幕误差（像素）。2 是经验值：更小只会让远处白烧顶点。 */
  readonly maxScreenErrorPx: number;
  /** 相机竖直视场角（弧度）。 */
  readonly fovY: number;
  /** 视口高度（像素）。 */
  readonly viewportHeight: number;
  /** LOD 最大层数，超过则钳制到最粗一级。 */
  readonly maxSteps: number;
}

/**
 * 按屏幕误差选 LOD 步长。
 *
 * 判据：一块地形用步长 s 采样时，最大的高度误差约为「该块高差」；
 * 换算到屏幕像素，误差 = 高差 / (距离 × tan(fov/2)) × 视口高度 / 2。
 * 取第一个满足「误差 ≤ maxScreenErrorPx」的步长。
 *
 * 不用「距离分档表」的原因：分档表的阈值依赖具体地形的起伏，
 * 换一张图就要重调；屏幕误差判据是自适应的，一张平地会自动降低 LOD 需求。
 */
export function selectLodStep(
  distance: number,
  elevationSpan: number,
  options: LodSelectionOptions,
): number {
  if (distance <= 0) return 1;
  const halfHeight = Math.tan(options.fovY * 0.5) * distance;
  if (halfHeight <= 0) return 1;
  const pixelsPerMeter = (options.viewportHeight * 0.5) / halfHeight;

  // 误差随步长**增大**而增大（采样越稀，漏掉的高频细节越多），
  // 随距离增大而减小（每米占的像素变少）。
  // 所以要从最粗一级往细里找第一个满足精度的，而不是反过来。
  let maxStep = 1;
  while (maxStep * 2 <= options.maxSteps) maxStep *= 2;

  for (let s = maxStep; s >= 2; s /= 2) {
    const spacing = options.chunkSize > 0 ? elevationSpan / options.chunkSize : 0;
    const errorPx = spacing * s * pixelsPerMeter;
    if (errorPx <= options.maxScreenErrorPx) return s;
  }
  return 1;
}

/** 块中心的世界坐标，LOD 选择与视锥剔除都用它。 */
export function chunkCenter(
  cx: number,
  cy: number,
  chunkSize: number,
  cellSize: number,
): { readonly x: number; readonly z: number } {
  const half = (chunkSize * cellSize) / 2;
  return { x: cx * chunkSize * cellSize + half, z: cy * chunkSize * cellSize + half };
}

/**
 * 生成一份 splat 材质参数。
 *
 * 只是数据，不碰任何渲染 API —— 地形包不认识 Three。渲染层读这些字段自己建材质。
 * 三层是移动端的上限：每多一层就多一次纹理采样，低端机填充率吃不住。
 */
export interface SplatLayer {
  /** 该层开始出现的高度（米）。 */
  readonly startElevation: number;
  /** 过渡区间宽度（米），避免硬边。 */
  readonly blendRange: number;
  /** 该层开始出现的坡度（弧度）。 */
  readonly startSlope: number;
  readonly textureKey: string;
  /** 纹理平铺密度（次/米）。 */
  readonly tileScale: number;
}

export interface SplatConfig {
  readonly layers: readonly SplatLayer[];
  /** 陡坡用三平面映射，避免垂直面被拉伸。 */
  readonly triplanar: boolean;
  /** 三平面映射的混合锐度，越大分界越硬。4~8 比较自然。 */
  readonly triplanarSharpness: number;
}

export function defaultSplatConfig(seaLevel: number): SplatConfig {
  return {
    layers: [
      { startElevation: seaLevel, blendRange: 2, startSlope: 0, textureKey: 'sand', tileScale: 0.25 },
      { startElevation: seaLevel + 8, blendRange: 6, startSlope: 0.5, textureKey: 'grass', tileScale: 0.2 },
      { startElevation: seaLevel + 60, blendRange: 25, startSlope: 0.9, textureKey: 'rock', tileScale: 0.12 },
    ],
    triplanar: true,
    triplanarSharpness: 6,
  };
}
