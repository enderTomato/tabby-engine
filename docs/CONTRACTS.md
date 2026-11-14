# 联动契约

这份文档回答一个具体问题：**一次事件（以「暴雨」为例）从物理世界发生，到屏幕上数字变化，
中间经过哪些子系统、按什么顺序、谁可以调谁。**

任何一端改了签名或时序，这里要同步改；测试与 `<android-check>` 清单都以此为准。

---

## 1. 依赖矩阵

包之间的 import 方向是**单向**的，反向依赖在 code review 阶段就该被拦下。

| 包 | 可以 import | 绝对不可以 import | 为什么 |
|---|---|---|---|
| `core` | 无 | 一切 | 事件总线与工具，谁都能用，它不能依赖谁 |
| `platform` | 无 | 渲染 / 物理 | 只做能力探测，跑在启动最早期 |
| `worker` | `core` | 渲染 / DOM | 物理跑在 Worker 里，没有 WebGL 上下文（ADR-002） |
| `physics` | `core` | **three / pixi / DOM** | 同上是硬红线；也保证物理包能在服务端跑 |
| `terrain` | `core` | 渲染 / 物理 | 只产网格数据，谁去画由上层决定 |
| `graph` | 无 | 经济 / 渲染 | 只认结构与成本，不认「建筑」「金币」 |
| `input` | 无 | 渲染 / three | 手势判据是时间与位移，与画什么无关 |
| `economy` | `core` | 渲染 / 物理 / `graph` | 只认 `LogisticsProvider` 接口（依赖倒置） |
| `render2d` / `render3d` | `core` / `platform` / `physics`（只读） | `economy` | 渲染读状态，不改状态 |
| `animation` | `core` | 渲染 | 只产插值数值 |
| `engine` | 上面全部 | `apps/*` | 编排层 |
| `apps/*` | 全部 | — | 应用层 |

两条最容易破的：

1. **`economy` 不能 import `graph`**。一旦 import，经济包就无法单独发布与单测
   （它的 31 项测试现在跑在纯 Node 里，没有图）。接法是结构化类型：
   `CityLogistics` 实现 `efficiencyOf(buildingId, city)`，两边互不知道对方存在。
2. **`physics` 不能 import `three`**。物理跑在 Worker 里，Worker 里 `import three`
   会连带引入 DOM 相关代码，在部分安卓 WebView 上直接抛错（而不是优雅降级）。

---

## 2. 每一帧的时序（60fps，主线程 16.6ms / CPU 预算 8ms）

```
┌─ rAF 回调开始 ────────────────────────────────────────────────┐
│ 1. Engine.update(dt)                                         │
│    ├ 读 Worker 回传的物理快照（SharedArrayBuffer 或拷贝）      │
│    ├ fixedUpdate：经济 advance(dt*1000)        ≤ 0.6ms        │
│    │   └ runDay → production/consumption/logistics/market …   │
│    └ 事件派发（month-end / famine / logistics-blocked）        │
│ 2. View 渲染                                                  │
│    ├ render3d.render()  投影流体/烟雾/布娃娃，orbit.update()   │
│    └ render2d.render()  Pixi 批次，< 150 drawcall             │
│ 3. RenderBridge.update()  标签投影 + 遮挡判定      ≤ 0.2ms     │
│ 4. InputManager.update()  长按 / 单击超期判定      < 0.01ms    │
└───────────────────────────────────────────────────────────────┘
```

**顺序是契约，不是实现细节**：

- 物理快照必须在经济之前读：否则这一帧的灌溉收益用的是上一帧的水量，
  玩家会看到「水落下去了但金币晚半秒才涨」。
- 招标投影（RenderBridge）必须在渲染之后：它要用本帧最终确定的相机矩阵。
  用上一帧的矩阵会出现「转视角时标签滞后一帧，看起来在抖」。
- 经济在渲染之前：渲染要显示的 HUD 数字来自本帧结算结果，不是上一帧的。

---

## 3. 「暴雨」端到端时序

一次暴雨从发生到界面可见，跨 6 个子系统。这里逐段列出**触发条件、数据形态、
以及失败时的表现**。

```
T+0ms      天气事件（玩法层，demo 里是「水塔持续出水」的等价物）
           │  产出：{ intensity: 0..1, windPhase: number }
           ▼
T+0..16ms  physics.WindField.sample(x,y,z,t,out)
           │  out: Float32Array(3)，风速分量（米/秒）
           │  注意：阵风用奇次幂塑形（s>0 ? s³ : 0），保证"多数时候平静、偶尔一阵"
           ▼
           physics.Smoke.setWind(field, coupling=3.2)
           │  v += (wind - v) * coupling  → 烟雾被风拖曳
           │
           physics.Ragdoll.addAcceleration(ax, ay, az, dt)
           │  布娃娃受风偏移，但**不改位置**（位置只能由约束求解器写）
           ▼
           物理步（60Hz，Worker 内）
           ├ Liquid.addSource / setFlowRate  → 液面高度场更新（CFL 自动切子步）
           ├ ObstacleGrid.queryPoint          → 宽相位：哪些点可能碰撞
           ├ 约束求解（PBD）+ 排水（exitFace / clampAboveBounds）
           └ 事件：bodySleep / collision / liquidOverflow
           │  产出：共享内存里的位置数组（零拷贝）
           ▼
T+16ms     主线程 Engine.fixedUpdate
           ├ 读流体注入量（本帧新增被吸收的水，取**增量**而不是累计值）
           │  生活经验：传累计值会让灌溉收益随粒子数抖动
           └ demo: sim.irrigate(units)
               └ 每 25 单位水 → economy.applyCommand({ type:'deposit', amount: 3 })
                  唯一入口原则：不改 cityStock，不直接加金库字段
           ▼
           economy.runDay()（每 500ms 真实时间 1 天，×2 速度则 250ms）
           ├ aggregate      城市住房/岗位
           ├ runProduction  产出 × 物流效率（每建筑每天只问一次 provider）
           ├ runConsumption 人口吃粮
           ├ runLogistics   读 scratchLogistics 统计「受阻 / 总数」
           ├ runMarket      价格向目标值 lerp（tick 级，对步长敏感 → 加速不改 dt）
           └ runPopulation  满意度 → 迁入/迁出
           │  产出：cityStock / price / satisfaction（Float32Array，定长）
           ▼
T+500ms    事件与提示
           ├ bus.emit('logistics-blocked')  blocked*2 >= total 才发，每城每天一次
           ├ bus.emit('famine') / 'boom' / 'month-end'
           └ demo: takeBlockedNotice() → flash() 一次性提示
           ▼
T+500ms+   界面
           ├ HUD（10Hz）：金库/人口/存粮/物流通行数
           ├ 小地图：断供建筑标暗红（Minimap.setBlockedTiles，只标脏不立刻重绘）
           ├ 3D 浮动标签：RenderBridge 投影 + 射线遮挡判定
           └ 诊断面板：物流统计 / 分块常驻 / 配置表状态 / 投影自检
```

### 这条链上最容易断的三处

| 位置 | 断法 | 表现 | 现在的处理 |
|---|---|---|---|
| 物理 → 经济 | 把「累计吸收量」而不是增量传给 `irrigate` | 收益随粒子数抖动，越到后面涨得越快 | `onFixed` 里 `absorbed += max(0, current - previous)` |
| 经济 → 界面 | 生产与统计各查一次物流 provider | HUD 显示「产量正常但 N 座断供」 | `scratchLogistics` 一次查询两处用 |
| 渲染 → 界面 | 用上一帧相机矩阵投影 | 转视角时标签滞后一帧，看着在抖 | `RenderBridge.update()` 放在 `render()` 之后 |

---

## 4. 接口清单（跨包契约）

只列**跨包**的，包内 API 看各自的 README。

| 契约 | 提供方 | 使用方 | 稳定性 |
|---|---|---|---|
| `LogisticsProvider.efficiencyOf(buildingId, city) → [0,1]` | `graph`（结构化实现） | `economy` | 结构固定，加方法不破坏 |
| `Economy.advance(realDeltaMs) / tickDays(n)` | `economy` | `engine`、`demo` | 时间唯一入口 |
| `Economy.applyCommand(cmd)` | `economy` | 一切改世界的调用方 | 加指令类型要改穷尽检查 |
| `EconomyState`（TypedArray 字段） | `economy` | `render2d`、诊断面板 | 只读；字段改名是破坏性 |
| `PhysicsWorld` 位置数组（SAB） | `physics`（Worker） | `render3d` | 布局固定，见 `PHYSICS_LAYOUT` |
| `ViewAdapter`（`init/render/resize/dispose`） | `engine` 定义 | `render2d`、`render3d` | 加钩子要给默认实现 |
| `GestureEvent`（16 种 discriminant） | `input` | `demo`、游戏层 | 加字段兼容，改 `kind` 破坏 |
| `CameraMatrices { projection, view, eye }` | `render3d` | `RenderBridge` | `view` 必须是 `matrixWorldInverse` |
| `LogisticsProvider` / `TerrainQuery` | `economy` 定义 | 上层实现 | 见 `docs/LOGISTICS.md` |
| `QualityProfile`（三档参数） | `platform` | `engine`、视图 | 加字段要给默认值 |

---

## 5. 确定性红线（跨系统）

以下三处**禁止**依赖 `Map` / `Set` / `Object.keys` 的遍历顺序做结算：

| 位置 | 正确做法 |
|---|---|
| 物理布娃娃遍历 | `world.getRagdollOrder()`（按 id 排序的数组） |
| 物流图最短路 | CSR 按 `(from, to)` 排序，等权 tie-break 按节点索引 |
| 渲染标签去重叠 | 按 `priority` + 距离排序，同分按 `id` 字典序 |

原因统一：JS 引擎对整数键的遍历顺序实现细节不同，而且「先建了哪条路、先放了哪个布娃娃」
会改变插入序 —— 同样的操作序列在不同设备上会算出不同结果，存档回放直接失效（ADR-001）。
