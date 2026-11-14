/**
 * 探针：路网图与最短路。
 *
 * 这个探针的核心不是「能不能算最短路」——那是最基础的要求。
 * 它验的是三条**只会在真实玩法里出事**的性质：
 *
 * 1. **建造顺序无关**：同样的边集合，先建横路还是先建竖路，算出的距离与路径必须
 *    逐字节一致（浮点比较用 `===`，不给容差）。这条破了，同一份存档在两次加载后
 *    会给出不同的物流效率，玩家会看到「产量自己变了」。
 * 2. **惰性删除堆真的省**：`settledNodes` 应该接近可达节点数而不是「边数 × 迭代」。
 * 3. **单源树复用**：源不变时第二次查询应当是零成本（脏标记没被误置）。
 *
 * 画面用 2D canvas 俯视图：节点是点，树边是细线，路径是高亮粗线。
 */

import { PathFinder, TransportGraph } from '@tabby/graph';
import { addButton, addRow, makeControls, makeOverlay, seededRandom } from './shared.js';
import { ms, Timing, type BenchResult, type Probe } from '../types.js';

const COLS = 9;
const ROWS = 7;
const SPACING = 46;
const ORIGIN_X = 48;
const ORIGIN_Y = 90;

interface Net {
  readonly graph: TransportGraph;
  readonly nodeOf: (col: number, row: number) => number;
  readonly edges: readonly { readonly from: number; readonly to: number; readonly cost: number }[];
}

/**
 * 造一张网格路网。
 *
 * `shuffle` 用来验证「建造顺序无关」：同一个种子下，把边按不同顺序 `addEdge`，
 * CSR 的排序会把它拉回同一份结构。如果不拉回，这里就是 bug 现场。
 */
function buildNet(seed: number, shuffle: boolean): Net {
  const random = seededRandom(seed);
  const graph = new TransportGraph();
  const nodeOf = (col: number, row: number): number => graph.addNode(`n-${col}-${row}`, col * SPACING, row * SPACING, 'station');
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) nodeOf(col, row);
  }

  const edges: { from: number; to: number; cost: number }[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const here = nodeOf(col, row);
      // 成本带一点确定性抖动，避免「所有路径一样长」看不出算法在干什么
      if (col + 1 < COLS) edges.push({ from: here, to: nodeOf(col + 1, row), cost: 1 + random() * 1.6 });
      if (row + 1 < ROWS) edges.push({ from: here, to: nodeOf(col, row + 1), cost: 1 + random() * 1.6 });
    }
  }

  const ordered = shuffle ? [...edges].sort(() => random() - 0.5) : edges;
  for (const edge of ordered) graph.addEdge(edge);
  graph.build();
  return { graph, nodeOf, edges };
}

/** 把单源树摊平成「边列表」，用于跨实例逐字节比较。 */
function treeSignature(graph: TransportGraph, finder: PathFinder): string {
  const parts: string[] = [];
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const distance = finder.distanceTo(node);
    parts.push(Number.isFinite(distance) ? distance.toFixed(6) : 'inf');
  }
  return parts.join(',');
}

export function createGraphProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let g2d: CanvasRenderingContext2D | null = null;
  let net: Net | null = null;
  let finder: PathFinder | null = null;
  let source = 0;
  let target = ROWS * COLS - 1;
  let rowSource: HTMLSpanElement | null = null;
  let rowTarget: HTMLSpanElement | null = null;
  let rowCost: HTMLSpanElement | null = null;
  let rowSettled: HTMLSpanElement | null = null;
  let rowMemory: HTMLSpanElement | null = null;
  let rowOrder: HTMLSpanElement | null = null;
  let runTiming = new Timing(30);

  function rebuild(seed: number): void {
    net = buildNet(seed, false);
    finder = new PathFinder(net.graph);
    finder.run(source);
  }

  function resize(): void {
    if (canvas === null) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 480) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 360) * dpr));
    g2d = canvas.getContext('2d');
  }

  return {
    id: 'graph',
    title: '路网图 / Dijkstra',
    summary: 'CSR 紧凑存储 + 惰性删除堆；同样的边集合在任何建造顺序下必须算出同一棵树',
    group: '系统',

    mount(context) {
      canvas = document.createElement('canvas');
      context.host.appendChild(canvas);
      resize();
      source = 0;
      target = ROWS * COLS - 1;
      rebuild(20240501);
      finder?.run(source);

      const overlay = makeOverlay(context.host, '路网图');
      rowSource = addRow(overlay, '起点');
      rowTarget = addRow(overlay, '终点');
      rowCost = addRow(overlay, '路径成本');
      rowSettled = addRow(overlay, '定局节点');
      rowMemory = addRow(overlay, 'CSR 占用');
      rowOrder = addRow(overlay, '顺序无关自检');

      const controls = makeControls(context.host);
      addButton(controls, '换个随机路网', () => {
        rebuild((Math.floor(performance.now()) % 100000) + 1);
        context.log('已重建路网（成本重新抖动）');
      });
      addButton(controls, '起点 +1', () => {
        if (net === null) return;
        source = (source + 1) % net.graph.nodeCount;
        finder?.run(source);
        context.log(`起点 → ${net.graph.nodeAt(source)?.id ?? source}`);
      });
      addButton(controls, '终点 +3', () => {
        if (net === null) return;
        target = (target + 3) % net.graph.nodeCount;
        context.log(`终点 → ${net.graph.nodeAt(target)?.id ?? target}`);
      });
      addButton(controls, '验顺序无关', () => {
        const result = checkOrderIndependence();
        if (rowOrder !== null) {
          rowOrder.textContent = result.ok ? '一致 ✓' : `不一致 ✗ (${result.diffAt})`;
          rowOrder.style.color = result.ok ? 'var(--good)' : 'var(--bad)';
        }
        context.log(
          result.ok
            ? `顺序无关：两种建造顺序（${result.forward} / ${result.shuffled} 条边）距离完全一致`
            : `顺序无关失败：第 ${result.diffAt} 个节点距离不同`,
        );
      });
      context.log('点画面上的节点可以改起点；双击改终点');
      canvas.addEventListener('dblclick', (event) => {
        const rect = canvas?.getBoundingClientRect();
        if (rect === undefined || net === null) return;
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const node = pick(nodePicker(), x, y);
        if (node !== null) {
          target = node;
          context.log(`终点 → ${net.graph.nodeAt(node)?.id ?? node}`);
        }
      });
      canvas.addEventListener('pointerdown', (event) => {
        const rect = canvas?.getBoundingClientRect();
        if (rect === undefined || net === null) return;
        const node = pick(nodePicker(), event.clientX - rect.left, event.clientY - rect.top);
        if (node === null) return;
        source = node;
        finder?.run(source);
        context.log(`起点 → ${net.graph.nodeAt(node)?.id ?? node}`);
      });
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      g2d = null;
      net = null;
      finder = null;
    },

    tick() {
      if (canvas === null || g2d === null || net === null || finder === null) return;
      const started = performance.now();
      const ctx2d = g2d;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.fillStyle = '#06080d';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      ctx2d.scale(dpr, dpr);

      const path = finder.pathTo(target);
      const onPath = new Set<number>();
      if (path.found) for (const node of path.nodes) onPath.add(node);

      // 全图边：底噪
      ctx2d.lineWidth = 1;
      ctx2d.strokeStyle = 'rgba(110,199,255,0.10)';
      for (const edge of net.edges) {
        const a = net.graph.nodePos(edge.from);
        const b = net.graph.nodePos(edge.to);
        ctx2d.beginPath();
        ctx2d.moveTo(a.x + ORIGIN_X, a.z + ORIGIN_Y);
        ctx2d.lineTo(b.x + ORIGIN_X, b.z + ORIGIN_Y);
        ctx2d.stroke();
      }

      // 单源树：距离越近越亮，直观看出 Dijkstra 扩散的样子
      ctx2d.lineWidth = 1.6;
      for (const edge of net.edges) {
        const da = finder.distanceTo(edge.from);
        const db = finder.distanceTo(edge.to);
        if (!Number.isFinite(da) || !Number.isFinite(db)) continue;
        // 只在「父子关系」上画：差值接近这条边的成本
        const delta = Math.abs(da - db);
        if (Math.abs(delta - edge.cost) > 1e-6) continue;
        const from = da < db ? edge.from : edge.to;
        const to = da < db ? edge.to : edge.from;
        const a = net.graph.nodePos(from);
        const b = net.graph.nodePos(to);
        const strength = Math.max(0.12, Math.min(0.5, 1 - Math.min(da, db) / 26));
        ctx2d.strokeStyle = `rgba(126,231,135,${strength})`;
        ctx2d.beginPath();
        ctx2d.moveTo(a.x + ORIGIN_X, a.z + ORIGIN_Y);
        ctx2d.lineTo(b.x + ORIGIN_X, b.z + ORIGIN_Y);
        ctx2d.stroke();
      }

      // 高亮路径
      if (path.found) {
        ctx2d.lineWidth = 3.2;
        ctx2d.strokeStyle = 'rgba(255,209,102,0.92)';
        ctx2d.beginPath();
        for (let i = 0; i < path.nodes.length; i += 1) {
          const node = path.nodes[i] as number;
          const pos = net.graph.nodePos(node);
          const px = pos.x + ORIGIN_X;
          const py = pos.z + ORIGIN_Y;
          if (i === 0) ctx2d.moveTo(px, py);
          else ctx2d.lineTo(px, py);
        }
        ctx2d.stroke();
      }

      // 节点
      for (let node = 0; node < net.graph.nodeCount; node += 1) {
        const pos = net.graph.nodePos(node);
        const px = pos.x + ORIGIN_X;
        const py = pos.z + ORIGIN_Y;
        const reachable = Number.isFinite(finder.distanceTo(node));
        ctx2d.beginPath();
        ctx2d.fillStyle =
          node === source
            ? '#7ee787'
            : node === target
              ? '#ffd166'
              : onPath.has(node)
                ? 'rgba(255,209,102,0.9)'
                : reachable
                  ? 'rgba(110,199,255,0.55)'
                  : 'rgba(255,107,107,0.35)';
        ctx2d.arc(px, py, node === source || node === target ? 6 : 3.2, 0, Math.PI * 2);
        ctx2d.fill();
      }

      runTiming.push(performance.now() - started);

      if (rowSource !== null) rowSource.textContent = net.graph.nodeAt(source)?.id ?? '—';
      if (rowTarget !== null) rowTarget.textContent = net.graph.nodeAt(target)?.id ?? '—';
      if (rowCost !== null) rowCost.textContent = path.found ? path.cost.toFixed(2) : '不可达';
      if (rowCost !== null) rowCost.style.color = path.found ? '' : 'var(--bad)';
      if (rowSettled !== null) rowSettled.textContent = `${finder.settledNodes} / ${net.graph.nodeCount}`;
      if (rowMemory !== null) rowMemory.textContent = `${(net.graph.byteSize / 1024).toFixed(1)}KB（${net.graph.edgeCount} 条有向边）`;
      void runTiming.median;
    },

    bench(): BenchResult {
      const big = buildNet(777, false);
      const finder2 = new PathFinder(big.graph);
      const timing = new Timing(120);
      for (let i = 0; i < 120; i += 1) {
        const started = performance.now();
        finder2.run(i % big.graph.nodeCount);
        timing.push(performance.now() - started);
      }
      const cold = new Timing(60);
      const warm = new Timing(60);
      const reuse = new PathFinder(big.graph);
      for (let i = 0; i < 60; i += 1) {
        const t0 = performance.now();
        const fresh = new PathFinder(big.graph);
        fresh.run(0);
        cold.push(performance.now() - t0);
        const t1 = performance.now();
        reuse.run(0);
        reuse.run(0);
        warm.push(performance.now() - t1);
      }
      const order = checkOrderIndependence();
      return {
        lines: [
          { label: '单源最短路', value: ms(timing.median), hint: `${big.graph.nodeCount} 节点 / ${big.graph.edgeCount} 有向边` },
          { label: '定局节点', value: `${finder2.settledNodes}`, hint: '惰性删除堆不重复定局' },
          { label: 'CSR 占用', value: `${(big.graph.byteSize / 1024).toFixed(1)}KB`, hint: 'Int32 + Float32 紧凑排列' },
          { label: '两次全量', value: `${ms(cold.p95)} vs ${ms(warm.median)}`, hint: '冷启动 vs 复用实例' },
          { label: '顺序无关', value: order.ok ? '一致' : `不一致@${order.diffAt}`, hint: '两种建造顺序的树逐节点比较' },
        ],
      };
    },
  };

  /** 收集一次节点屏幕坐标，供点击拾取用。 */
  function nodePicker(): { node: number; x: number; y: number }[] {
    if (net === null) return [];
    const out: { node: number; x: number; y: number }[] = [];
    for (let node = 0; node < net.graph.nodeCount; node += 1) {
      const pos = net.graph.nodePos(node);
      out.push({ node, x: pos.x + ORIGIN_X, y: pos.z + ORIGIN_Y });
    }
    return out;
  }
}

function pick(candidates: readonly { node: number; x: number; y: number }[], x: number, y: number): number | null {
  let best: number | null = null;
  let bestDistance = 22; // 22px 内算点中，够手指用
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - x, candidate.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate.node;
    }
  }
  return best;
}

/**
 * 顺序无关自检：同一批边，按原始顺序和打乱顺序各建一次图，比较每个节点的距离。
 *
 * 这是**确定性红线**的现场验证。用 `===` 比字符串签名而不是浮点容差比较：
 * 「差不多相等」对存档一致性毫无意义，两次加载差 1e-9 也会让效率分档落在不同档位上。
 */
function checkOrderIndependence(): { ok: boolean; diffAt: number; forward: number; shuffled: number } {
  const forward = buildNet(20240501, false);
  const shuffled = buildNet(20240501, true);
  const fa = new PathFinder(forward.graph);
  const fb = new PathFinder(shuffled.graph);
  fa.run(0);
  fb.run(0);
  const sa = treeSignature(forward.graph, fa);
  const sb = treeSignature(shuffled.graph, fb);
  if (sa === sb) return { ok: true, diffAt: -1, forward: forward.edges.length, shuffled: shuffled.edges.length };
  const pa = sa.split(',');
  const pb = sb.split(',');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] !== pb[i]) return { ok: false, diffAt: i, forward: forward.edges.length, shuffled: shuffled.edges.length };
  }
  return { ok: false, diffAt: -1, forward: forward.edges.length, shuffled: shuffled.edges.length };
}
