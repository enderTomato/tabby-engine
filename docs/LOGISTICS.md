# 物流链路：路网 → 经济

这份文档描述「一条路铺下去，为什么会让一块田减产」的完整链路。
它是一条**跨包契约**：任何一端改签名，另一端必须在编译期炸，而不是在运行期静默返回 0。

## 1. 数据流

```
玩家铺路 / 拆路
   │
   ▼
TransportGraph.build()            CSR 重建，graphVersion += 1
   │
   ▼
CityLogistics.invalidate()        效率缓存清空 + 枢纽最短路树标脏
   │
   ▼
CityLogistics.refreshAll()        枢纽 Dijkstra 重算，写入 network.caches
   │
   ▼
Economy.runDay() ─ runProduction  每栋生产建筑问一次 efficiencyOf(building, city)
   │                              产出 ×= 效率
   ▼
Economy.runDay() ─ runLogistics   读同一次结果，统计「受阻数 / 总数」
   │
   ▼
Economy.bus.emit('logistics-blocked')   半数以上受阻才发（每天最多一次）
```

## 2. 接口契约

经济层只认一个方法，定义在 `packages/economy/src/types.ts`：

```ts
export interface LogisticsProvider {
  /** [0,1]，0 = 完全断供，1 = 通畅。tick 级调用（每建筑每天一次）。 */
  efficiencyOf(buildingId: number, city: number): number;
}
```

`packages/graph` 的 `CityLogistics` **不 import 经济包**，靠结构化类型对上
（它自己声明了同形状的 `EfficiencyLogisticsProvider`）。这样两边可以独立发布、独立单测。

### 必须遵守的三条

| 规则 | 后果 |
| --- | --- |
| 返回值必须落在 `[0, 1]`，非有限数视为 0 | `NaN` 会顺着 `scale *= factor` 污染库存，而 `Float32Array` 里的 `NaN` 写进存档后会让整档报废。经济层有 `sanitizeEfficiency` 兜底，但不要依赖它 |
| 同一 tick 内同一参数必须返回同值 | 经济层只在 `runProduction` 里问一次并存进 `scratchLogistics`，`runLogistics` 读那份结果。若 provider 自身有随机性，HUD 会出现「3/2 座受阻」这种自相矛盾的数字 |
| 不能抛异常 | `runProduction` 在日结算主循环里，抛异常会让整个 tick 停在半路（部分建筑已扣料、部分未产出），状态进入不可复现的半成品 |

## 3. 效率曲线

```ts
efficiencyFromCost(cost, freeDistance = 12, zeroDistance = 90)
```

```
1 ┤────────╮
  │        │╲
  │        │ ╲
0 ┤        │  ╲────────
  └────────┴───┴─────── cost
        free   zero
```

- `cost ≤ free`：不惩罚。「门口就是路」不该被扣产出。
- `free < cost < zero`：线性衰减。
- `cost ≥ zero` 或不可达（`Infinity`）：0。

两个参数是玩法旋钮，不是性能参数。demo 里取 `free=4, zero=22`：
网格最大曼哈顿距离是 16，取 22 是为了让「被墙逼着绕路」也能被压到 0 ——
否则玩家会觉得墙「没什么用」。

## 4. 未接入路网的建筑

**不惩罚（效率 1）。** 这不是漏判，是三选一的取舍：

| 方案 | 症状 |
| --- | --- |
| 未接入 → 0（判断供） | 刚放下的楼立刻停产，玩家看不到产出却查不出原因 |
| 未接入 → 1（宽限） | 存在「永远不连路也满产」的漏洞 |
| 未接入 → 抛错 | demo 里每放一栋楼就崩一次 |

选宽限，并把「连了路但不通」作为唯一的断供条件。要堵漏洞应该在放置逻辑里要求连路，
而不是让物流层去猜。

## 5. 单 tick 内的调用次数

一栋生产建筑每天被问 **1 次**，不是 2 次。这一点由 `EconomyState.scratchLogistics` 保证：

```
runProduction:  factor = provider.efficiencyOf(id, city)
                state.scratchLogistics[id] = factor
runLogistics:   blocked += state.scratchLogistics[id] <= 0.01
```

若两次分别查询，路网在两次调用之间重算（分帧 `recompute` 就会）时，
生产与统计会基于不同版本的图 —— 玩家看到「产量正常但提示断供」。

## 6. 事件

```ts
economy.bus.on('logistics-blocked', ({ city, blocked, total }) => { ... });
```

- **只统计有产出的建筑**（`output.length > 0`）。住宅不参与物流，算进去会让阈值失去意义。
- **阈值是 `blocked * 2 >= total`**。一两个建筑断供是常态（新盖的还没连路），
  半数以上才值得弹提示。
- **每个城市每天最多一次**，在 `runDay` 末尾、日期推进之前发。

## 7. 缓存与失效

| 层 | 何时失效 | 谁负责 |
| --- | --- | --- |
| `CityLogistics.efficiency` | 建筑换位置 / 路网重建 / `invalidate()` | `bindBuilding` / `unbindBuilding` 自动；路网变更由调用方显式 `invalidate()` |
| `LogisticsNetwork.caches` | `graphVersion` 变化 | `cost()` 自查版本号，过期退回 A* |
| CSR | `build()` | `TransportGraph` |

**顺序不能反**：路网变了必须先 `invalidate()` 再 `refreshAll()`。
只做后者会让新的距离树与旧的效率缓存并存，表现为「有一半建筑按旧图算」。

## 8. 性能预算

| 操作 | 实测 | 触发频率 |
| --- | --- | --- |
| `graph.build()`（72 节点 / 122 边） | ~0.02 ms | 每次挡板增删 |
| `graph.build()`（200 节点 / 800 边） | ~0.05 ms | 每次批量铺路 |
| 枢纽 Dijkstra | ~0.05 ms / 源 | 路网变更后 |
| `efficiencyOf` 命中缓存 | ~20 ns | 每建筑每天 |

结论：路网变更走同步 `refreshAll()` 完全够用（城市数 1~4，总计 <0.2ms），
不需要为了它做分帧。分帧接口 `refresh(budget)` 留给「地图编辑器里连续刷几十条路」的场景。

## 9. demo 里的具体取舍

demo 的路网是 **72 格全连接网格，挡板阻断通行**：

- 枢纽固定为 `(0, 0)`（`HUB_TILE`）。取角落而不是中心，是为了让距离梯度在整张图上单调 ——
  放中心的话四个角距离相同，看起来像没生效。
- 挡板既是水坝又是路障。这是 demo 里第一个「同一件物件有两种代价」的设计：
  玩家把田围起来挡水，顺手就把自己的供应链掐了。
- 普通建筑（住宅/农田）不改变通行关系，只 `bindBuilding`，不重建图。

对应测试见 `apps/demo/tests/logistics.test.ts`（14 项），
其中包含「把三块田围死 → 食物停止增长」的端到端断言。
