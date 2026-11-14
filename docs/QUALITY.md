# 画质与稳定性（3D 侧）

决策理由见 [ADR-008](adr/ADR-008-3d-quality.md)。这一页是**操作手册**：参数是什么、
数字该是多少、出了问题先看哪里。

## 一、动态分辨率（DRS）

```
packages/render3d/src/drs.ts
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `targetFrameMs` | 16.7 | 低端档应传 33.3（它本来就跑 30fps，拿 16.7 当目标会一路降到底） |
| `minScale` / `maxScale` | 0.7 / 1.0 | 低于 0.7 画面明显糊，不如关特效 |
| `step` | 0.05 | 每档 5% |
| `downRatio` / `upRatio` | 1.15 / 0.85 | 迟滞区 30%，中间不动 |
| `cooldownMs` | 1500 | 改分辨率要重建 drawing buffer，冷却期内不重评估 |
| `evalIntervalMs` | 500 | 每半秒看一次中位数 |
| `minSamples` | 30 | 刚切场景时样本不够，不下结论 |

最终 drawing buffer 尺寸：

```
bufferW = cssW × min(dpr, maxPixelRatio) × renderScale × drsScale
```

`renderScale` 是档位给的上限，`drsScale` 在这个上限内浮动。**只有这一处乘法** ——
不再叠加 `setPixelRatio`，否则「缓冲到底多大」要读者在脑子里乘三次。

### 该看到的数字

- 稳 60fps 的机器：`drsScale` 应该稳在 1.00，`adjustments` 不涨。
- 稳 40fps 的机器：会降到 0.85~0.90 后停住。
- `adjustments` 每秒涨好几次 → 防抖参数被改坏了，或者目标帧时间设错了档位。

## 二、阴影预算

```
packages/render3d/src/shadow-budget.ts
```

| 档位 | 结果 | mapSize |
|---|---|---|
| `tier=low` | 全关 | — |
| 中端 | 单级 | 512²（DRS < 0.85 时 256²） |
| 高端 | 两级（两盏独立平行光） | 近 1024²/18m、远 512²/60m（吃紧时各减半） |

「两级」不是 CSM：两盏灯各自独立，没有级联拼接缝，也没有动态切分。诊断面板上的
`shadowReason` 直接说明当前为什么是这个尺寸。

**为什么低端直接关而不是「只投一部分」**：半开的观感（一半物体有影子）比全关更糟，
而且它省不下那次 shadow pass 的固定开销。

## 三、建筑 LOD

```
packages/render3d/src/lod.ts        分类（纯函数，可测）
packages/render3d/src/building-lod.ts  两个 InstancedMesh + 贴片朝向
```

- 进入近景 26m / 退出 30m：**迟滞带 4m**，站在分界线挪几步不会来回切。
- 超过 110m 直接不画（雾在 40~80m 就盖掉了）。
- 近景 = 实例化方盒（有影子），远景 = billboard 贴片（不投影，平面投出来的影子是错的）。
- 相机移动 < 1.5m 不重新分类：分类只要 O(n) 次比较，但重写实例矩阵要上传 GPU。

贴片贴图走 `setImpostorTexture(texture)`。没有烘焙图集时是纯色剪影 —— 这是刻意的降级态。

### 该看到的数字

诊断面板 `建筑 LOD 近 N / 远 M / 剔除 K`。把相机推远，近景数应该单调减少、远景数增加；
在分界线附近来回移动时两个数**不应该跳变**（跳变 = 迟滞没生效）。

## 四、上下文丢失

```
packages/render3d/src/context-guard.ts
```

必做两件事：

1. `webglcontextlost` 里调 `event.preventDefault()` —— 不调，`webglcontextrestored` 永远不来。
2. 恢复后延迟一帧再重建。驱动可能还没就绪，立刻创建纹理有概率拿到 `INVALID_OPERATION`。

`ContextGuard` 只负责「冻结 / 通知」，重建由视图的 `onRestored` 做：重置 DRS 样本、
重算分辨率、丢弃旧帧时间。业务侧的模拟暂停由引擎订阅同一个事件。

### 怎么验

```js
const gl = canvas.getContext('webgl2');
gl.getExtension('WEBGL_lose_context').loseContext();
setTimeout(() => gl.getExtension('WEBGL_lose_context').restoreContext(), 300);
```

恢复后应当：画面回来、`上下文 丢失 1 次 · 恢复 1 次`、控制台无报错。
`node tools/smoke-demo.mjs` 已经把这段做成了自动化检查。

## 五、KTX2 纹理

见 [ASSETS.md](ASSETS.md)。要点只有一句：解码器（527KB + 285KB）不进主包，
加载器走动态 `import()`，回退次数 `fallbacks` 是线上最该盯的数字。

## 排障速查

| 现象 | 先看 | 常见原因 |
|---|---|---|
| 分辨率来回跳 | `qualityInfo.adjustments` | 冷却/迟滞被改小；目标帧时间与档位不匹配 |
| 建筑闪烁 | 近景/远景两个数 | 迟滞带被设成 0 |
| 切后台回来白屏 | `contextLost` | 没 `preventDefault()`，或恢复后没重建 |
| 远处建筑变成灰片 | `textureError` | 贴图没加载；这是预期降级，不是 bug |
| 帧率不稳但 `drsScale` 不动 | `medianFrameMs` | 中位数被「一半好一半坏」的帧拉平；查是不是 GC 周期性卡顿 |
