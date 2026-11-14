import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransportGraph,
  PathFinder,
  LogisticsNetwork,
  TileLogistics,
  BinaryHeap,
  CityLogistics,
  efficiencyFromCost,
} from '../dist/index.js';

/** 造一条 0-1-2-...-n 的链，每段成本 1。 */
function makeChain(n) {
  const g = new TransportGraph();
  for (let i = 0; i < n; i += 1) g.addNode(`n${i}`, i * 10, 0, 'station');
  for (let i = 0; i < n - 1; i += 1) g.addEdge({ from: i, to: i + 1, cost: 1 });
  g.build();
  return g;
}

test('CSR：双向边插入后正向反向都可走', () => {
  const g = makeChain(3);
  assert.equal(g.nodeCount, 3);
  assert.equal(g.edgeCount, 4, '2 条无向边 = 4 条有向边');
  const f = new PathFinder(g);
  f.run(0);
  assert.equal(f.distanceTo(2), 2);
  f.run(2);
  assert.equal(f.distanceTo(0), 2);
});

test('CSR：邻居遍历顺序与建造顺序无关（确定性）', () => {
  const build = (order) => {
    const g = new TransportGraph();
    for (let i = 0; i < 4; i += 1) g.addNode(`n${i}`, 0, 0, 'station');
    for (const i of order) g.addEdge({ from: i, to: i + 1, cost: 1 });
    g.build();
    const seq = [];
    const range = g.edgeRange(1);
    for (let e = range[0]; e < range[1]; e += 1) seq.push(g.target(e));
    return seq;
  };
  const a = build([0, 1, 2]);
  const b = build([2, 0, 1]);
  assert.deepEqual(a, b, '邻接表顺序必须由节点编号决定，不受建造顺序影响');
});

test('最短路：等权环形图上 tie-break 稳定', () => {
  // 0-1-2 与 0-3-2 都是长度 2，两条等权路径
  const g = new TransportGraph();
  for (let i = 0; i < 4; i += 1) g.addNode(`n${i}`, i, 0, 'station');
  g.addEdge({ from: 0, to: 1, cost: 1 });
  g.addEdge({ from: 1, to: 2, cost: 1 });
  g.addEdge({ from: 0, to: 3, cost: 1 });
  g.addEdge({ from: 3, to: 2, cost: 1 });
  g.build();

  const f = new PathFinder(g);
  f.run(0);
  const first = Array.from(f.pathTo(2).nodes);
  f.run(0);
  const second = Array.from(f.pathTo(2).nodes);
  assert.deepEqual(first, second, '同一张图两次查询必须给同一条路径');
  assert.equal(first.length, 3);
});

test('最短路：不可达返回 Infinity 且不崩', () => {
  const g = new TransportGraph();
  g.addNode('a', 0, 0);
  g.addNode('b', 100, 0);
  g.build();
  const f = new PathFinder(g);
  f.run(0);
  assert.equal(f.distanceTo(1), Infinity);
  assert.equal(f.pathTo(1).found, false);
});

test('最短路：maxNodes 限制扩散并如实报告未完成', () => {
  const g = makeChain(50);
  const f = new PathFinder(g);
  const complete = f.run(0, 5);
  assert.equal(complete, false, '达到上限必须报告 false');
  assert.ok(f.settledNodes <= 5);
});

test('A*：启发式为 0 时与 Dijkstra 结果一致', () => {
  const g = new TransportGraph();
  for (let i = 0; i < 6; i += 1) g.addNode(`n${i}`, i, 0, 'station');
  g.addEdge({ from: 0, to: 1, cost: 2 });
  g.addEdge({ from: 1, to: 2, cost: 2 });
  g.addEdge({ from: 0, to: 2, cost: 10 });
  g.addEdge({ from: 2, to: 3, cost: 1 });
  g.addEdge({ from: 3, to: 4, cost: 1 });
  g.build();

  const dijkstra = new PathFinder(g);
  dijkstra.run(0);
  const aStar = new PathFinder(g, { heuristicScale: 0 });
  const result = aStar.aStar(0, 4);
  assert.equal(result.cost, dijkstra.distanceTo(4));
});

test('图：拒绝 0 成本边（会产生等距环）', () => {
  const g = new TransportGraph();
  g.addNode('a', 0, 0);
  g.addNode('b', 1, 0);
  assert.throws(() => g.addEdge({ from: 0, to: 1, cost: 0 }), /成本必须为正/);
});

test('图：拒绝引用不存在节点的边', () => {
  const g = new TransportGraph();
  g.addNode('a', 0, 0);
  assert.throws(() => g.addEdge({ from: 0, to: 5, cost: 1 }), /不存在的节点/);
});

test('网络：缓存命中后查询成本是 O(1) 读取', () => {
  const g = makeChain(10);
  const net = new LogisticsNetwork(g, { maxCachedSources: 4 });
  assert.equal(net.cachedSources, 0);

  net.markSourcesDirty([0]);
  assert.equal(net.pendingSources, 1);
  net.recompute(4);
  assert.equal(net.cachedSources, 1);
  assert.equal(net.pendingSources, 0);

  assert.equal(net.cost(0, 9), 9);
  assert.equal(net.cachedSources, 1, '查询不该产生新缓存');
});

test('网络：分帧重算每次只处理 budget 个源', () => {
  const g = makeChain(10);
  const net = new LogisticsNetwork(g);
  net.markSourcesDirty([0, 1, 2, 3]);
  assert.equal(net.recompute(2), 2, '剩余 2 个');
  assert.equal(net.recompute(2), 0);
  assert.equal(net.cachedSources, 4);
});

test('网络：边变更后旧缓存作废', () => {
  const g = new TransportGraph();
  for (let i = 0; i < 4; i += 1) g.addNode(`n${i}`, i * 10, 0, 'station');
  g.addEdge({ from: 0, to: 3, cost: 100 });
  g.build();

  const net = new LogisticsNetwork(g);
  net.markSourcesDirty([0]);
  net.recompute(1);
  assert.equal(net.cost(0, 3), 100);

  // 修一条捷径
  g.addEdge({ from: 0, to: 1, cost: 1 });
  g.addEdge({ from: 1, to: 2, cost: 1 });
  g.addEdge({ from: 2, to: 3, cost: 1 });
  g.build();
  net.markSourcesDirty([0, 1, 2, 3]);
  net.recompute(1);
  assert.equal(net.cost(0, 3), 3, '重算后应走捷径');
});

test('网络：缓存上限触发淘汰，不会无限增长', () => {
  const g = makeChain(20);
  const net = new LogisticsNetwork(g, { maxCachedSources: 3 });
  const all = [];
  for (let i = 0; i < 10; i += 1) all.push(i);
  net.markSourcesDirty(all);
  net.recompute(10);
  assert.equal(net.cachedSources, 3, `缓存应被限制在 3，实际 ${net.cachedSources}`);
});

test('网络：不可达返回 Infinity', () => {
  const g = new TransportGraph();
  g.addNode('a', 0, 0);
  g.addNode('b', 100, 0);
  g.build();
  const net = new LogisticsNetwork(g);
  net.markSourcesDirty([0]);
  net.recompute(1);
  assert.equal(net.cost(0, 1), Infinity);
});

test('地块适配器：未接入路网的地块不惩罚（返回 0）', () => {
  const g = makeChain(4);
  const net = new LogisticsNetwork(g);
  net.markSourcesDirty([0, 1, 2, 3]);
  net.recompute(4);

  const tiles = new TileLogistics(net, 100);
  tiles.bind(10, 0);
  tiles.bind(11, 3);

  assert.equal(tiles.transportCost(10, 11), 3, '已接入：返回真实成本');
  assert.equal(tiles.transportCost(10, 99), 0, '未接入的地块视为本地自给');
  assert.equal(tiles.transportCost(10, 10), 0, '同一地块无运输');
});

test('地块适配器：成本上限生效，不可达返回 Infinity', () => {
  const g = makeChain(10);
  const net = new LogisticsNetwork(g);
  net.markSourcesDirty([0]);
  net.recompute(1);

  const tiles = new TileLogistics(net, 5);
  tiles.bind(1, 0);
  tiles.bind(2, 9);
  assert.equal(tiles.transportCost(1, 2), 5, '成本应被上限截断');

  // 断开连接后不可达
  const isolated = new TransportGraph();
  isolated.addNode('x', 0, 0);
  isolated.addNode('y', 10, 0);
  isolated.build();
  const net2 = new LogisticsNetwork(isolated);
  const tiles2 = new TileLogistics(net2, 100);
  tiles2.bind(1, 0);
  tiles2.bind(2, 1);
  assert.equal(tiles2.transportCost(1, 2), Infinity);
});

test('二叉堆：等权时按节点索引出队', () => {
  const heap = new BinaryHeap(8);
  heap.push(5, 1);
  heap.push(2, 1);
  heap.push(9, 0);
  assert.equal(heap.pop(), 9, 'key 最小优先');
  assert.equal(heap.pop(), 2, 'key 相同时节点索引小的先出');
  assert.equal(heap.pop(), 5);
  assert.equal(heap.pop(), -1);
});

test('CSR 内存占用显著小于对象图（同一张 200 节点图）', () => {
  const g = new TransportGraph();
  for (let i = 0; i < 200; i += 1) g.addNode(`n${i}`, i * 10, 0, 'station');
  for (let i = 0; i < 200; i += 1) {
    g.addEdge({ from: i, to: (i + 1) % 200, cost: 1 });
    g.addEdge({ from: i, to: (i + 7) % 200, cost: 2 });
  }
  g.build();
  // 400 条无向边 = 800 有向边：4 条数组 × 800 × 4 字节 + offsets(201×4)
  const expected = 800 * 4 * 4 + 201 * 4;
  assert.equal(g.byteSize, expected);
  assert.ok(g.byteSize < 16384, `CSR 占用 ${g.byteSize} 字节，应远小于对象图`);
});

// ---------------------------------------------------------------------------
// CityLogistics：经济层 LogisticsProvider 的实现
// ---------------------------------------------------------------------------

test('效率折算：分段线性，边界闭合', () => {
  assert.equal(efficiencyFromCost(0, 10, 100), 1);
  assert.equal(efficiencyFromCost(10, 10, 100), 1, '恰好等于 freeDistance 仍不惩罚');
  assert.equal(efficiencyFromCost(100, 10, 100), 0, '达到 zeroDistance 归零');
  assert.equal(efficiencyFromCost(200, 10, 100), 0, '超出归零');
  assert.equal(efficiencyFromCost(Infinity, 10, 100), 0, '不可达归零');
  // 中点 (10+100)/2 = 55 → 0.5
  assert.ok(Math.abs(efficiencyFromCost(55, 10, 100) - 0.5) < 1e-6);
  // 退化参数不能炸
  assert.equal(efficiencyFromCost(5, 10, 10), 1);
  assert.equal(efficiencyFromCost(50, 10, 10), 0);
});

/** 造一张 10 节点链 + 一座城市，枢纽在节点 0。 */
function makeCity() {
  const g = makeChain(10);
  const net = new LogisticsNetwork(g);
  const tiles = new TileLogistics(net, 100);
  for (let i = 0; i < 10; i += 1) tiles.bind(100 + i, i);
  const logi = new CityLogistics(tiles, { cityCount: 1, freeDistance: 2, zeroDistance: 10 });
  logi.setHub(0, 100);
  logi.refreshAll();
  return { g, net, tiles, logi };
}

test('CityLogistics：近处满效率、远处衰减、不可达归零', () => {
  const { logi } = makeCity();

  logi.bindBuilding(0, 101); // 距离 1
  logi.bindBuilding(1, 105); // 距离 5
  logi.bindBuilding(2, 109); // 距离 9

  assert.equal(logi.efficiencyOf(0, 0), 1, '距离 1 在免惩罚区内');
  const mid = logi.efficiencyOf(1, 0);
  assert.ok(mid > 0.5 && mid < 0.8, `距离 5 应衰减但不归零，实际 ${mid}`);
  const far = logi.efficiencyOf(2, 0);
  assert.ok(far > 0 && far < mid, `距离 9 应比距离 5 更差，实际 ${far}`);
});

test('CityLogistics：拆掉中间一段路后远端立即断供', () => {
  const g = makeChain(10);
  const net = new LogisticsNetwork(g);
  const tiles = new TileLogistics(net, 100);
  for (let i = 0; i < 10; i += 1) tiles.bind(100 + i, i);
  const logi = new CityLogistics(tiles, { cityCount: 1, freeDistance: 2, zeroDistance: 10 });
  logi.setHub(0, 100);
  logi.refreshAll();
  logi.bindBuilding(7, 107);
  assert.ok(logi.efficiencyOf(7, 0) > 0, '断路前是通的');

  // 重建一张只到节点 4 的图（模拟拆路），并复用同一个 tiles 映射
  const cut = new TransportGraph();
  for (let i = 0; i < 5; i += 1) cut.addNode(`n${i}`, i * 10, 0, 'station');
  for (let i = 0; i < 4; i += 1) cut.addEdge({ from: i, to: i + 1, cost: 1 });
  cut.build();
  const net2 = new LogisticsNetwork(cut);
  const tiles2 = new TileLogistics(net2, 100);
  for (let i = 0; i < 5; i += 1) tiles2.bind(100 + i, i);
  tiles2.bind(107, 9); // 节点 9 现在孤立
  const logi2 = new CityLogistics(tiles2, { cityCount: 1, freeDistance: 2, zeroDistance: 10 });
  logi2.setHub(0, 100);
  logi2.refreshAll();
  logi2.bindBuilding(7, 107);
  assert.equal(logi2.efficiencyOf(7, 0), 0, '孤立节点必须判断供');
});

test('CityLogistics：未接入路网的建筑不惩罚（新建建筑的宽限期）', () => {
  const { logi } = makeCity();
  logi.bindBuilding(0, 999); // 地块没绑定到节点
  assert.equal(logi.efficiencyOf(0, 0), 1);

  const fresh = new CityLogistics(makeCity().tiles, { cityCount: 1 });
  // 完全没绑定过建筑 → 也是 1
  assert.equal(fresh.efficiencyOf(3, 0), 1);
});

test('CityLogistics：效率缓存命中，且路网重建后自动失效', () => {
  const { g, logi } = makeCity();
  logi.bindBuilding(0, 105);
  logi.efficiencyOf(0, 0);
  const first = logi.missCount;
  for (let i = 0; i < 50; i += 1) logi.efficiencyOf(0, 0);
  assert.equal(logi.missCount, first, '重复查询必须走缓存');

  // 追加一条捷径后重建，图版本变化应让缓存作废
  g.addEdge({ from: 0, to: 5, cost: 1 });
  g.build();
  logi.refreshAll();
  assert.ok(logi.missCount > first || logi.efficiencyOf(0, 0) === 1, '路网变了要重算');
  assert.equal(logi.efficiencyOf(0, 0), 1, '捷径开通后距离 1，满效率');
});

test('CityLogistics：unbindBuilding 后槽位复用不继承旧效率', () => {
  const { logi } = makeCity();
  logi.bindBuilding(0, 109);
  const far = logi.efficiencyOf(0, 0);
  assert.ok(far < 0.5);

  logi.unbindBuilding(0);
  logi.bindBuilding(0, 101); // 同一 id 换到近处
  assert.equal(logi.efficiencyOf(0, 0), 1, '换位置后必须重算');
});

test('CityLogistics：容量自动扩容，超出预分配也不崩', () => {
  const { logi } = makeCity();
  logi.bindBuilding(5000, 101);
  assert.equal(logi.efficiencyOf(5000, 0), 1);
  assert.equal(logi.efficiencyOf(999999, 0), 1, '未绑定的超大 id 走宽限路径');
});

test('CityLogistics：多城市各自用自己的枢纽', () => {
  const g = makeChain(10);
  const net = new LogisticsNetwork(g);
  const tiles = new TileLogistics(net, 100);
  for (let i = 0; i < 10; i += 1) tiles.bind(100 + i, i);
  const logi = new CityLogistics(tiles, { cityCount: 2, freeDistance: 2, zeroDistance: 10 });
  logi.setHub(0, 100); // 节点 0
  logi.setHub(1, 105); // 节点 5
  logi.refreshAll();

  logi.bindBuilding(0, 101); // 距城市 0 枢纽 1 步，距城市 1 枢纽 4 步
  assert.equal(logi.efficiencyOf(0, 0), 1);
  const fromCity1 = logi.efficiencyOf(0, 1);
  assert.ok(fromCity1 < 1, `同一建筑在 city 1 口径下应更差，实际 ${fromCity1}`);
});

test('CityLogistics：接口与 @tabby/economy 的 LogisticsProvider 同构', async () => {
  // 经济层只要求有一个 efficiencyOf(buildingId, city) 方法；
  // 这里不 import 经济包，只用结构化断言守住「形状没变」这件事。
  const { logi } = makeCity();
  assert.equal(typeof logi.efficiencyOf, 'function');
  const v = logi.efficiencyOf(1, 0);
  assert.ok(v >= 0 && v <= 1, `效率必须落在 [0,1]，实际 ${v}`);
});
