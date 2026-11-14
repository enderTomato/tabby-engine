# @tabby/graph —— 物流图

紧凑存储的运输图 + 最短路缓存 + 经济层适配器。**不依赖渲染包，也不依赖经济包**。

```bash
pnpm --filter @tabby/graph build
node --test packages/graph/tests/*.test.mjs
```

## 三个层次

```
TransportGraph      CSR 紧凑存储（节点坐标 + 有向边）
  └ LogisticsNetwork  单源最短路树缓存 + 脏标记分帧重算
      └ TileLogistics     地块 ↔ 地块 的运输成本
          └ CityLogistics 建筑 → 城市枢纽 的效率（喂给经济层）
```

## 为什么是 CSR 而不是 `Map<node, Edge[]>`

一张 200 节点、800 条边的路网：

| 表示 | 内存 | 遍历序 |
| --- | --- | --- |
| `Map<number, Edge[]>` | ~100 KB，散在堆上 | 插入序（= 玩家建造顺序） |
| CSR（4 条连续数组） | ~13 KB | 按 `(from, to)` 排序，与建造顺序无关 |

第二列是性能问题，第三列是**确定性红线**（ADR-001）：同样的路网、不同的建造顺序，
必须算出同一条最短路，否则存档回放对不上。

## 三层缓存

```
1. CityLogistics.efficiency[buildingId]   Float32Array   建筑 → 效率，-1 = 未算
2. LogisticsNetwork.caches[hubNode]       单源最短路树    枢纽 → 全图距离
3. TransportGraph (CSR)                   图结构本身
```

失效只能自上而下：路网变了要作废全部三层。反过来（只作废第一层）会出现
「路已经拆了但货还在运」，这是最难查的一类 bug —— 因为它只影响数值，不报错。

## 用法

```ts
import { TransportGraph, LogisticsNetwork, TileLogistics, CityLogistics } from '@tabby/graph';

const graph = new TransportGraph();
const hub = graph.addNode('hub', 0, 0, 'city');
const shop = graph.addNode('shop', 40, 0, 'station');
graph.addEdge({ from: hub, to: shop, cost: 2 }); // 不传 directed 即双向
graph.build();

const network = new LogisticsNetwork(graph);
const tiles = new TileLogistics(network);
tiles.bind(100, hub); // 地块 100 → 节点 hub
tiles.bind(200, shop);

const logistics = new CityLogistics(tiles, {
  cityCount: 1,
  freeDistance: 12, // 这个距离内不惩罚
  zeroDistance: 90, // 到这个距离效率归零
});
logistics.setHub(0, 100); // 城市 0 的枢纽是地块 100
logistics.refreshAll();

const farmId = 7;
logistics.bindBuilding(farmId, 200);
logistics.efficiencyOf(farmId, 0); // 0.97
```

把 `logistics` 直接传给经济层即可（两个包互不依赖，靠结构化类型对上）：

```ts
const economy = new Economy({ logistics });
// 路网变化后：
logistics.bindBuilding(newId, tile);
logistics.invalidate(); // 或 refreshAll()
```

## 效率曲线

`efficiencyFromCost(cost, free = 12, zero = 90)`：

- `cost ≤ free` → `1`（门口就是路，不该被扣）
- `free < cost < zero` → 线性衰减
- `cost ≥ zero` 或不可达 → `0`

改这两个数字是在改玩法，不是在调性能：`free` 决定玩家能白嫖多远，
`zero` 决定「多远算断供」。

## 设计取舍

**为什么建筑要连到枢纽，而不是建筑之间互连。**
经济内核是城市级库存（`cityStock[city][res]`），没有逐栋建筑的运单。
若按建筑两两配对，500 栋楼就是 25 万次查询/天；按「到枢纽」建模则退化成单源问题，
查询是一次数组读取，与建筑数量无关。代价是近似：两栋相邻但都远离枢纽的楼，
物流效率都低 —— 这在城市尺度上是可以接受的失真。

**为什么 `clearEdges()` 而不是 `removeEdge()`。**
CSR 的段内排序是确定性的基础，逐条删除会破坏它；重建一次 200 节点约 0.05ms，
远低于维护增量结构的 bug 面。

**为什么 `efficiency` 缓存的键要含城市。**
同一栋建筑在 city 0 的枢纽下是 1，在 city 1 的枢纽下可能是 0.3。
只用 `buildingId` 做键，先问 city 0 再问 city 1 会返回旧值 ——
在多城市地图上表现为「城郊的厂被上游城市带飞」。

## 性能参考

| 场景 | 耗时 |
| --- | --- |
| `build()` 200 节点 800 边 | ~0.05 ms |
| 单次 Dijkstra（同上） | ~0.05 ms |
| `efficiencyOf` 命中缓存 | ~20 ns（两次 Map 查询 + 一次数组读） |
| `efficiencyOf` 未命中（有缓存树） | ~50 ns |
| `efficiencyOf` 未命中（无缓存树） | 一次 A*，约 0.05 ms |

所以高频路径上必须保证「枢纽的最短路树已缓存」：
路网变更后调 `refreshAll()`（或分帧 `refresh(budget)`），不要靠 `cost()` 自己现算。
