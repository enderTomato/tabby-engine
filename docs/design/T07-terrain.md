# T07 · 地形高程导入流水线设计

> 状态：已实现（Node 侧管线 + 浏览器侧加载器）
> 关联：T08 地形网格、T10 液体（都要读这里的接口）

## 1. 为什么必须在 Node 侧做

浏览器解析 16bit 高度图会**静默丢精度**，而且不报错：

| 路径 | 结果 |
|---|---|
| `<canvas>` drawImage + getImageData | 一律降到 8bit。0~65535 变成 0~255，3000m 的落差量化误差从 ±0.02m 变成 ±6m |
| WebGL 上传 16bit 纹理 | 可以，但只能给 GPU 用，CPU 侧拿不到原值，碰撞与寻路没法算 |
| JS 手写 PNG 解码 | 可行，但要自己处理 filter / 大端 / 无 zlib（浏览器没有同步 inflate，只能异步流） |

而 16bit 的价值就在精度：SRTM 1 arc-second 的高程范围通常 0~4000m，用 8bit 存储每级台阶就是 15.7 米——城市地块的坡度判定会完全失真。

**结论：预处理必须在 Node 侧离线完成，产物是引擎自有格式，浏览器只负责按需取块。**

## 2. 源格式支持

| 格式 | 说明 | 解析难点 | 实现 |
|---|---|---|---|
| 16bit PNG 灰度 | 艺术化高度图 / 从 DEM 转出的图 | 大端 16bit；5 种 filter；调色板需拒绝 | ✅ 自写解码器（`tools/lib/png-decode.mjs`） |
| 8bit PNG | 同上但精度低 | 无——只是精度不够 | ✅ 同上，带警告 |
| SRTM `.hgt` | NASA/USGS 1 或 3 arc-second | 无头；int16 大端；行 0 是**北**；`-32768` 是 void 不是高程 | ✅ `tools/lib/hgt-decode.mjs` |
| ESRI ASCII Grid `.asc` | 文本栅格，常见于公开数据转换 | 头字段不统一；NODATA 缺省 -9999 | ✅ `tools/lib/asc-decode.mjs` |
| GeoTIFF | 最完整的 DEM 格式 | 需要投影信息、多波段、压缩块，解析器体积远超收益 | ❌ 建议用 GDAL 离线转成 `.asc` 或 16bit PNG |

**为什么不用 pngjs**：实测它对 16bit 灰度图返回值失真（输入 137 读成 255）。既然全流程的立意就是"不让精度丢在解析这一步"，换一个同样会丢的库没有意义，所以自写解码器（约 140 行，只依赖 Node 内置 `zlib`）。

## 3. 自有格式：`.r16` + `meta.json`

### `.r16`

裸 `Uint16` 小端数组，行优先，**无文件头**。

- 不做文件头：头信息全部集中在 `meta.json`，同一张图的所有 LOD 与分块共享一份元数据。避免"改了 meta 忘了改块头"的不一致
- 不用 KTX2 R16：KTX2 的容器与超压缩对这里没用。我们要的是"能按字节偏移随机读一个块"，`fetch` + `Range` 就够，零依赖
- 小端固定：浏览器与 Node 都按小端写，`DataView` 读时显式指定 `true`，跨端一致

### 量化

```
u16 = round((elevation - minElevation) / (maxElevation - minElevation) × 65535)
elevation = minElevation + (u16 / 65535) × (maxElevation - minElevation)
```

量化误差 = `(max - min) / 65535 / 2`。3000m 跨度 → ±0.023m，远小于 SRTM 本身的垂直精度（±16m）。**量化不是瓶颈，源数据才是。**

### `meta.json` 结构

```jsonc
{
  "version": 1,                    // 存档迁移靠它
  "width": 256, "height": 256,
  "cellSizeMeters": 30,            // 单格水平距离
  "minElevation": 0, "maxElevation": 3000,
  "seaLevel": 0,                   // 水域/可建性判定基准
  "verticalScale": 1,              // 仅影响渲染
  "projection": { "type": "local", "metersPerUnit": 1 },
  "license": { "source": "", "url": "", "attribution": "", "redistribution": "attribution" },
  "lods": [
    { "level": 0, "step": 1,  "width": 256, "height": 256 },              // LOD0 走分块
    { "level": 1, "step": 2,  "width": 128, "height": 128, "file": "lods/1/height.r16" }
  ],
  "chunks": { "chunkSize": 128, "chunksX": 2, "chunksY": 2, "pathTemplate": "chunks/{lod}/{x}_{y}.r16" },
  "normalFile": "normal.rgba8",
  "flowFile": null,
  "generator": "terrain-tools 0.1.0",
  "generatedAt": "..."
}
```

`version` 是硬约束：加载器读到非 1 直接抛错，不做"尽力兼容"——静默兼容会让错档的地形以正确姿态呈现，比崩溃更难查。

## 4. 产物结构

```
out/
├─ meta.json
├─ chunks/0/0_0.r16 ...      # LOD0 分块，每块 chunkSize² × 2B
├─ lods/1/height.r16          # 低阶 LOD 整图
├─ lods/2/height.r16
├─ normal.rgba8               # RGB=法线，A=坡度
└─ flow.rgba8                 # RG=下坡方向（可选）
```

**LOD0 分块、低阶整图** 的原因：LOD0 数据量最大且只在近处需要，必须流式；低阶 LOD 整图也不大（1/4、1/16），一次拉完反而省请求数。

## 5. 数据量预算

| 源尺寸 | LOD0 裸数据 | 分块数（128） | 单片 | 备注 |
|---|---|---|---|---|
| 1024² | 2 MB | 64 | 32 KB | 一次加载可接受 |
| 2048² | 8 MB | 256 | 32 KB | 建议流式 |
| 4096² | 32 MB | 1024 | 32 KB | **必须流式**，整图会触发 Android 内存告警 |
| 8192² | 128 MB | 4096 | 32 KB | 需要配合 LOD 与按需卸载 |

SRTM 1 arc-second 单幅 3601² ≈ 25MB。整幅加载在低端机（≤2GB）上等于自杀，所以默认走分块。

## 6. 坐标系与投影

- **运行时一律米制平面坐标**：(x, z)，原点在栅格西北角，x 向东、z 向南
- 栅格行列：`col = x / cellSize`，`row = z / cellSize`，**row 0 是最北**
- 经纬度只在 `meta.projection` 里留档，用于溯源与"这段山脉在哪个国家"

为什么不运行时用经纬度：商品流、寻路、碰撞全是米制，经纬度会把球面几何塞进每个循环。投影只在离线做一次。

`equirect`（等距圆柱）在小范围（< 500km）误差可接受；跨大洲的《群星》式地图应该用游戏内虚构坐标系，不要试图投影真实地球。

## 7. 与下游的接口约定

### T08 地形网格

```ts
// 只读，且必须支持跨块插值
field.sampleWorld(x, z): number        // 米，双线性
field.slopeAt(col, row): number        // 弧度
field.normalAt(col, row): [x, y, z]
field.isBuildable(col, row, maxSlope?): boolean
```

地形网格生成器**不得**自己实现双线性——重复实现会导致物理碰撞与视觉表面错位。

### T10 液体

液体需要两个东西：

1. `sampleWorld` 作为溢出判定边界（水位 > 地形高度才流）
2. `flow.rgba8` 作为初始流向，省一次梯度计算（可选优化，没有也能算）

**当前 `FluidSolver` 还没有接这个接口**——这是 ADR-006 里记录的返工项。

### T15 经济

经济层只查两个布尔：`isBuildable`、`isUnderwater`。**不要给经济层传 HeightField 引用**——那会让经济层能改地形，违反单向数据流。

## 8. 用法

```bash
# 16bit PNG（需给定米制映射区间）
node packages/terrain/tools/preprocess.mjs ./dem.png --out ./public/terrain \
  --format png-16bit --min-elev 0 --max-elev 3200 \
  --cell-size 30 --chunk 128 --lod 0,1,2 --flow \
  --license-source "SRTM 1 Arc-Second" --attribution "NASA/USGS"

# SRTM .hgt（值本身是米，自动统计范围）
node packages/terrain/tools/preprocess.mjs ./N40E116.hgt --out ./public/terrain \
  --cell-size 90 --license-source "SRTM" --attribution "NASA/USGS"
```

运行时：

```ts
const loader = new TerrainLoader({ baseUrl: '/terrain', maxCachedChunks: 64 });
const field = await loader.loadAll();          // 小图
// 或按需：
const chunk = await loader.loadChunk(3, 5);    // 大图流式
```

## 9. 实测结果

256×256 合成地形（0~3000m 双峰 + 河谷）：

```
源文件     256×256 png-16bit
量化误差   ±0.023 m
分块       2×2 = 4 个  128 KB
LOD        256² / 128²  32 KB
法线图     256 KB
总产物     680 KB      处理 44ms

还原误差   max 0.0001m  avg 0.0000m     ← 16bit 精度完整保留
插值中心   1765.71m vs 四角均值 1765.71m  ← 双线性正确
法线图     与运行时烘焙差异 0            ← 工具与运行时不漂移
LOD1 峰值  48109 vs LOD0 48116          ← 降采样合理
```

601×601 `.hgt`（含 void 空洞）：

```
void 填补  655 个 → 高程范围修正为 3.0~1800.0m（修复前被 -32768 拉成 -32768~1800）
LOD        601² / 300² / 150²
处理       77ms
```

## 10. 自检清单：Android 上最可能的三个坑

1. **分块请求数爆炸**：chunkSize 取太小（如 32）会让 4096² 变成 16384 个请求，移动网络下 RTT 就是灾难。**128 是下限**，4096² 图上不要低于 128。

2. **16bit 在传输途中被降级**：某些 CDN 或图片优化代理会把 `.r16` 当图片处理并转码。必须用正确的 MIME（`application/octet-stream`）并禁用图片优化规则——否则你拿到的是 8bit，且没有任何报错。

3. **内存峰值**：`loadAll()` 在 4096² 上会一次性分配 32MB 的 `Uint16Array` 加 32MB 的 `ArrayBuffer`（解码中间态），低端机直接 OOM。**大图必须 `loadChunk`**，并且 `maxCachedChunks` 要按档位设置（低端 32、中端 64、高端 128）。
