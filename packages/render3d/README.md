# @tabby/render3d

Three.js 适配层：地形、实例化建筑、点精灵流体/烟雾、布娃娃骨架线，以及**画质与稳定性**的四套机制。

## 模块

| 文件 | 职责 | 能在 Node 里测 |
|---|---|---|
| `view3d.ts` | `ViewAdapter` 实现；把档位、DRS、阴影、LOD、上下文丢失串起来 | — |
| `points-layer.ts` | 单 DrawCall 承载全部粒子（自定义 shader，逐点尺寸/透明度） | — |
| `orbit.ts` | 轨道相机控制器，组合 `@tabby/input` 的 `OrbitDriver` | — |
| `bridge.ts` | 世界→屏幕投影、视锥剔除、射线-AABB 遮挡、去重叠。**不 import three** | ✅ |
| `drs.ts` | 动态分辨率：帧时间中位数 + 迟滞 + 冷却 | ✅ |
| `shadow-budget.ts` | 按档位与 DRS 决定阴影级数与 mapSize | ✅ |
| `lod.ts` | 建筑远近分类（带迟滞，遍历序固定） | ✅ |
| `building-lod.ts` | 实例化方盒 ↔ billboard 贴片两个 `InstancedMesh` | — |
| `context-guard.ts` | `webglcontextlost` / `restored`：`preventDefault` + 延迟重建 | ✅ |

## 两条边界

1. **`bridge.ts` 不 import three**。矩阵运算是纯数学，这样投影与遮挡逻辑能在 Node 里单测，
   也能给 Pixi 侧复用。
2. **渲染读状态，不改状态**。流体位置、烟雾粒子、布娃娃点位都来自 `engine` 暴露的
   TypedArray，渲染层只读。物理包完全不知道 Three 的存在。

## 画质机制

参数、预期数字与排障见 [docs/QUALITY.md](../../docs/QUALITY.md)，决策理由见
[ADR-008](../../docs/adr/ADR-008-3d-quality.md)。要点：

- **DRS**：分辨率的乘数只有一处（`bufferW = cssW × min(dpr, maxPixelRatio) × renderScale × drsScale`）。
- **阴影**：低端全关 / 中端单级 / 高端两盏独立平行光。**明确不做 CSM**（4 次 shadow pass 在手机上是负收益）。
- **LOD**：进 26m 出 30m，迟滞 4m；贴片贴图留烘焙接口（没有资产管线，不假装烘过）。
- **上下文丢失**：不 `preventDefault()` 就永远等不到恢复 —— 这是白屏且不可恢复的根因。

测试：`pnpm --filter @tabby/render3d test`（43 项）。
