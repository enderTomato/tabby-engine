/**
 * Demo 的路网 —— 把 72 个地块连成一张运输图，喂给经济层的物流接口。
 *
 * ## 玩法含义
 *
 * 地块之间默认四邻可通，**挡板会阻断通行**。所以「挡板」从这个版本起是双关的：
 * 它既是拦水的坝，也是栏路的路障。玩家把田围在挡板后面不只会改变水流，
 * 还会把自己的供应链掐断 —— 这是本 demo 里第一个「同一件物件有两种代价」的设计。
 *
 * ## 为什么是「到市政厅的距离」而不是「田到住宅」
 *
 * 经济内核是城市级库存（`cityStock[city][res]`），没有逐栋建筑的运单。
 * 硬造 OD 对会得到 O(建筑²) 的查询矩阵，而且内核拿不到「哪栋楼在消费」这个信息。
 * 所以模型取近似：每栋建筑必须能走到市政厅（(0,0) 格），走不到就断供。
 * 单源最短路，一次查询一个数组读取。
 *
 * ## 为什么每次建造都重建整张图
 *
 * 72 节点 / 约 130 条无向边，重建约 0.02ms（实测在低端安卓上不到 0.1ms）。
 * 换成增量维护（逐条加删边 + 修正最短路树）的代码量和 bug 面完全不划算，
 * 而且增量更新最短路是**局部有效**的，边界条件错一次就变成「拆了墙路还通」。
 */

import { CityLogistics, LogisticsNetwork, TileLogistics, TransportGraph } from '@tabby/graph';
import { CELL_SIZE, GRID_COLS, GRID_ROWS, TILE_COUNT, indexOf } from './city';

/**
 * 市政厅所在地块 —— 路网的单源。
 *
 * 取 (0,0) 角落而不是地图中心：角落到最远角的网格距离是 11 + 5 = 16，
 * 距离梯度在整张图上都是单调的，玩家能直接看出「越远越堵」。
 * 放中心则四个方向的角落距离相同，看起来反而像没生效。
 */
export const HUB_TILE = indexOf(0, 0);

/** 这个距离以内不惩罚：贴着市政厅的楼不该因为「多走两步」被扣产出。 */
export const ROAD_FREE_DISTANCE = 4;

/**
 * 到这个距离效率归零。
 *
 * 最大可能的网格距离是 16（对角）。取 22 是为了让「最远角 + 绕路」也能被压到 0：
 * 单纯直线距离永远到不了 22，但被挡板逼着绕圈可以 —— 这样玩家才会觉得
 * 「墙真的把路堵死了」，而不是「效率只是低了一点点」。
 */
export const ROAD_ZERO_DISTANCE = 22;

/** 每个地块的四个邻居方向（右、下、左、上）。只用右和下建边，避免重复。 */
const RIGHT = 1;
const DOWN = GRID_COLS;

export class CityRoads {
  readonly graph: TransportGraph;
  readonly network: LogisticsNetwork;
  readonly tiles: TileLogistics;
  readonly logistics: CityLogistics;

  /** 挡板位置，1 = 不可通行。与 `cells` 投影分开存：这里只关心「通不通」。 */
  private readonly walls: Uint8Array;
  private blockedCount = 0;

  constructor(cityCount = 1) {
    this.walls = new Uint8Array(TILE_COUNT);

    this.graph = new TransportGraph();
    for (let row = 0; row < GRID_ROWS; row += 1) {
      for (let col = 0; col < GRID_COLS; col += 1) {
        // 节点坐标给 A* 用；只要求与网格同构，不必等于世界坐标
        this.graph.addNode(`t${indexOf(col, row)}`, col * CELL_SIZE, row * CELL_SIZE, 'tile');
      }
    }
    this.rebuildEdges();

    // 枢纽数量 = 城市数（1~4），缓存上限给 8 足够，超了也不会错，只是退化到 A* 现算
    this.network = new LogisticsNetwork(this.graph, { maxCachedSources: 8 });
    this.tiles = new TileLogistics(this.network, 100);
    for (let tile = 0; tile < TILE_COUNT; tile += 1) this.tiles.bind(tile, tile);

    this.logistics = new CityLogistics(this.tiles, {
      cityCount,
      buildingCapacity: TILE_COUNT * 4,
      freeDistance: ROAD_FREE_DISTANCE,
      zeroDistance: ROAD_ZERO_DISTANCE,
    });
    for (let city = 0; city < cityCount; city += 1) this.logistics.setHub(city, HUB_TILE);
    this.logistics.refreshAll();
  }

  /** 挡板增删的唯一入口。返回是否真的改变了通行关系（重复调用幂等）。 */
  setWall(tile: number, on: boolean): boolean {
    if (tile < 0 || tile >= TILE_COUNT) return false;
    const next = on ? 1 : 0;
    if (this.walls[tile] === next) return false;
    this.walls[tile] = next;
    this.blockedCount += on ? 1 : -1;
    this.rebuildEdges();
    this.logistics.refreshAll();
    return true;
  }

  isWall(tile: number): boolean {
    if (tile < 0 || tile >= TILE_COUNT) return false;
    return this.walls[tile] === 1;
  }

  /**
   * 与某个地块直接相邻且可通行的地块数。
   *
   * 挡板本身返回 0：墙里站不了人，讨论「它有几个邻居」没有意义，
   * 而在诊断面板上把墙显示成「4 通」会让人误以为那里能走。
   */
  openNeighbors(tile: number): number {
    if (tile < 0 || tile >= TILE_COUNT) return 0;
    if (this.walls[tile] === 1) return 0;
    const col = tile % GRID_COLS;
    const row = (tile - col) / GRID_COLS;
    let n = 0;
    if (col > 0 && !this.isWall(tile - 1)) n += 1;
    if (col < GRID_COLS - 1 && !this.isWall(tile + 1)) n += 1;
    if (row > 0 && !this.isWall(tile - GRID_COLS)) n += 1;
    if (row < GRID_ROWS - 1 && !this.isWall(tile + GRID_COLS)) n += 1;
    return n;
  }

  /**
   * 整体复位：拆掉所有挡板、清空所有建筑绑定。
   *
   * 读档专用。不能只靠 `onPlaced` 重放 —— 重放只做加法，
   * 上一个存档里存在、这个存档里不存在的挡板会留在 `walls` 里继续堵路，
   * 症状是「读了另一份存档，路莫名其妙不通，而且画面上看不到任何墙」。
   */
  reset(): void {
    this.walls.fill(0);
    this.blockedCount = 0;
    this.rebuildEdges();
    this.logistics.clearBuildings();
    this.logistics.refreshAll();
  }

  /** 建筑放置/拆除时同步映射。经济层的 buildingId 是稀疏槽位，会复用，所以拆时必须解绑。 */
  bindBuilding(buildingId: number, tile: number): void {
    this.logistics.bindBuilding(buildingId, tile);
  }

  unbindBuilding(buildingId: number): void {
    this.logistics.unbindBuilding(buildingId);
  }

  /** 挡板数量，诊断面板用。 */
  get wallCount(): number {
    return this.blockedCount;
  }

  /**
   * 全量重铺路网。
   *
   * 只在下述情况调用：挡板增删、读档、地形编辑。普通建筑（住宅/农田）
   * 不改变通行关系，只 `bindBuilding`，不会走到这里。
   */
  private rebuildEdges(): void {
    this.graph.clearEdges();
    for (let row = 0; row < GRID_ROWS; row += 1) {
      for (let col = 0; col < GRID_COLS; col += 1) {
        const from = indexOf(col, row);
        if (this.walls[from] === 1) continue; // 墙里不能站人，也就没有从墙出发的边
        if (col + 1 < GRID_COLS && this.walls[from + RIGHT] === 0) {
          this.graph.addEdge({ from, to: from + RIGHT, cost: 1 });
        }
        if (row + 1 < GRID_ROWS && this.walls[from + DOWN] === 0) {
          this.graph.addEdge({ from, to: from + DOWN, cost: 1 });
        }
      }
    }
    this.graph.build();
  }
}
