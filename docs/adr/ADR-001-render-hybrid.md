# ADR-001 · 2D/3D 渲染混合方案

- **状态**：Accepted
- **日期**：2026-11-14
- **决策者**：项目方 + AI 联合架构
- **影响范围**：`packages/render2d`、`packages/render3d`、`packages/engine`；任务 T04

## 背景

引擎需要同时呈现 3D 城市场景（地形、建筑、单位）与 2D 层（HUD、小地图、建筑图标、选择框、建筑详情面板）。两者必须能独立刷新：3D 每帧都变，2D 大部分时间静止。

Android 上 WebGL context 是最稀缺的资源。老驱动（Mali-4xx、PowerVR Rogue 早期）在多 context 场景下有明确的崩溃与花屏记录，而 WebView 的 context 丢失往往不给任何回调。

## 可选方案

| 方案 | 优点 | 缺点 | Android 风险 |
|---|---|---|---|
| A. 双 canvas，各自独立 WebGL context | 渲染器互不干扰；2D 可独立降频；某个 context lost 不影响另一个 | 两个 context 各占显存；无法直接做跨层深度排序 | 多 context 在老驱动上本就危险，但**隔离**让我们能丢一个保一个 |
| B. 共享一个 WebGL context，用 scissor/viewport 切换 | 显存省一半；深度缓冲共享，排序自然 | Pixi 与 Three 抢同一个 context 的状态机（blend/depth/stencil），任何一方忘记复位就炸；升级任一方都可能破坏另一方的假设 | 状态泄漏导致的画面异常排查成本极高 |
| C. 全用 Three 的 CSS2D / Sprite 做 UI | 单一渲染器，概念统一 | UI 表达力受限于 3D 管线；文字清晰度与布局能力远不如 DOM/Pixi | 文字在低 DPR 设备上糊成一团 |

## 决策

**选 A：双 canvas + 独立 WebGL context。**

两个 canvas 在 DOM 里层叠，2D 层 `pointer-events: none` 透传到底层 3D，需要交互的 UI 元素单独开启。

## 后果

### 正面

- Pixi 与 Three 的升级完全解耦，任何一方升大版本不牵连另一方
- 2D 层可以降到 15fps 甚至只在状态变更时重绘，省下的 CPU 全给 3D
- context lost 处理可以做成"丢一个保一个"：3D 挂了，2D 面板还能显示错误与降级提示
- 调试时能单独关掉任一渲染器

### 负面

- 显存占用翻倍。低端机（≤2GB）两个 1080p context 各约 8-16MB，可接受但不免费
- **跨层排序无法通过深度缓冲解决**：2D 的悬浮血条要盖在 3D 建筑上，只能靠 DOM 层级 + 每帧手动算可见性
- 需要额外同步两层的 DPR 与尺寸，否则点击坐标会偏

## 风险与缓解

| 风险 | 触发条件 | 缓解措施 |
|---|---|---|
| 老驱动上创建第二个 context 直接失败 | Mali-4xx / PowerVR 早期 | `Engine.start()` 对每个视图独立 try/catch，失败记入 `failedViewIds` 并广播 `view-error`，其余视图照常工作 |
| 两个 context 各自丢帧不同步 | 后台切换、内存压力 | 待补：`webglcontextlost` 监听与协商恢复（当前为已知缺口） |
| 点击坐标偏移 | 两层 DPR 或尺寸不一致 | 两层共用同一个 `resize(width, height, dpr)` 调用，DPR 上限统一取档位值 |

## 相关

- 代码：`packages/render2d/src/view2d.ts`、`packages/render3d/src/view3d.ts`
- 容器隔离：`packages/engine/src/view.ts`（`ViewAdapter` 契约）
- 任务：T04；缺口待补 RenderBridge（2D 查询 3D 屏幕坐标）
