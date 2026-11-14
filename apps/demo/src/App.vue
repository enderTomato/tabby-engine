<script setup lang="ts">
import { AnimationSystem } from '@tabby/animation';
import { Engine } from '@tabby/engine';
import type { PhysicsBounds } from '@tabby/physics';
import { Renderer2DView, type BoxSpec } from '@tabby/render2d';
import { RenderBridge, Renderer3DView, type Box3DSpec, type OccluderBox } from '@tabby/render3d';
import { InputManager } from '@tabby/input';
import {
  CELL_COLOR,
  CELL_HEIGHT,
  CELL_SIZE,
  CITY_KNOBS,
  CitySimulation,
  HUB_TILE,
  TOOLS,
  TOOL_LABEL,
  configHost,
  costOf,
  createCityKnobPanel,
  cellFromWorld,
  cellRect,
  indexOf,
  obstaclesOf,
  zSpanOf,
  zonesOf,
  GRID_COLS,
  GRID_ROWS,
  TOWER,
  WORLD_MIN_X,
  type ToolKind,
} from '@tabby/gameplay';
import { LabelPool, ToastQueue, type KnobPanel, type LabelVisual } from '@tabby/ui';
import { gsap } from 'gsap';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

const BOUNDS: PhysicsBounds = { min: { x: -14, y: 0, z: -6 }, max: { x: 14, y: 16, z: 6 } };

/**
 * 水塔浇灌的列。水塔本体在 x=-13.6，只能浇到它右侧这几列。
 *
 * 为什么是三个点轮流出水而不是一股：`spawnFluid` 只支持位置抖动，给不了水平初速，
 * 一股水永远是垂直下落，只能浇到正下方一格。三个点让喷淋覆盖 col 0~2，
 * 玩家的农田摆在这一带才有收成 —— 这是物理约束下的取舍，不是喷泉美术。
 */
const WATER_COLS: readonly number[] = [0, 1, 2];
/** 喷淋落到第几行。种子农田就在这一行，玩家挪走农田后就得自己把新田摆回来。 */
const FARM_ROW = 3;

const stageEl = ref<HTMLDivElement | null>(null);
const canvas2d = ref<HTMLCanvasElement | null>(null);
const canvas3d = ref<HTMLCanvasElement | null>(null);
/** 小地图。像素数据在 `sim.minimap` 里，这里只是一块放大显示的画布。 */
const minimapEl = ref<HTMLCanvasElement | null>(null);
/** 3D 模式下的浮动标签层（建筑名 + 物流效率），由 RenderBridge 定位。 */
const overlayEl = ref<HTMLDivElement | null>(null);

const mode = ref<'2d' | '3d'>('2d');
const tool = ref<ToolKind>('house');
const speed = ref<1 | 2 | 4>(2);
const showDiag = ref(false);
const diagText = ref('');

/**
 * Toast 走队列而不是一个字符串。
 *
 * 一个 `ref<string>` 的问题是「后一条覆盖前一条」：玩家连点建造，
 * 提示全被冲掉，等于没有提示。队列在 `onFrame` 里 10Hz 推进一次，
 * 只有当前该显示的那条变了才写 ref —— 队列本身不进响应式。
 */
const toastQueue = new ToastQueue({ ttlMs: 2200 });
const toast = ref('欢迎来到 Tabby Engine 测试用例');

/**
 * 仿真层在 setup 顶层构造：它不碰 DOM，只跑经济内核的构造与种子放置。
 * **不要**把它塞进 Vue 的 reactive —— 内核内部是几十个 TypedArray，
 * 包上 Proxy 之后每次 `state.cityTreasury[i]` 都会走一层拦截，
 * 而结算每帧要访问上万次。这里只把「要显示的字段」同步进 hud。
 */
let sim = new CitySimulation(0);

const hud = reactive({ ...sim.hud() });

/** 配置表状态（热重载 / 覆盖表校验结果），直接显示在诊断面板里。 */
const configStatus = ref('内置配置表');

/**
 * 调参面板。
 *
 * `knobValues` 是**唯一允许存副本**的地方：滑块需要双向绑定，而真实值散在
 * Economy / CityLogistics / CitySimulation 三处。`KnobPanel.refresh()` 会从世界里重读，
 * 所以读档、热重载、外部改参数之后调一次即可，不必担心面板撒谎。
 *
 * 面板自己也是「写入后回读确认」的 —— 写不进世界就把滑块弹回真实值，
 * 失败原因通过 `knobFeedbacks` 显示在滑块下面。
 */
let knobPanel: KnobPanel | null = null;
const knobValues = reactive<Record<string, number>>({});
const knobFeedbacks = reactive<Record<string, string>>({});
/** 面板上要渲染的旋钮定义。`CitySimulation` 换了实例也还是同一批。 */
const knobSpecs = CITY_KNOBS;

function bindKnobs(): void {
  knobPanel = createCityKnobPanel(sim);
  for (const id of Object.keys(knobValues)) delete knobValues[id];
  for (const id of Object.keys(knobFeedbacks)) delete knobFeedbacks[id];
  Object.assign(knobValues, knobPanel.values);
  for (const spec of knobPanel.specs) knobFeedbacks[spec.id] = '';
}

function syncKnobs(): void {
  if (knobPanel === null) return;
  knobPanel.refresh();
  Object.assign(knobValues, knobPanel.values);
}

function applyKnob(id: string, value: number): void {
  if (knobPanel === null) return;
  const result = knobPanel.apply(id, value);
  // 无论成功与否都以世界回读值为准：写失败时滑块弹回真实值，而不是停在假值上
  knobValues[id] = result.actual;
  knobFeedbacks[id] = result.reason;
  refreshHud();
}

/** 分块流式加载的统计。 */
const streamStats = reactive({ enabled: false, resident: 0, total: 0, loads: 0, unloads: 0 });

const stats = reactive({
  fps: 0,
  cpu: 0,
  fluid: 0,
  smoke: 0,
  mode: '-',
  tier: '-',
  draw: 0,
});

let engine: Engine | null = null;
let view2d: Renderer2DView | null = null;
let view3d: Renderer3DView | null = null;
const animation = new AnimationSystem();
let resizeObserver: ResizeObserver | null = null;
let frameCounter = 0;

let waterTimer = 0;
let waterSeq = 0;
let smokeTimer = 0;
let pendulumTimer = 0;
let ragdollSeq = 0;
const ragdollIds: string[] = [];
let prevZones: number[] = [];

const pct = (value: number): string => `${Math.round(value * 100)}%`;

const hint = computed(() =>
  mode.value === '2d'
    ? `点击网格建造${TOOL_LABEL[tool.value]}（${costOf(tool.value)} 金币）；水塔会浇灌靠左的农田，挡板能挡住水流`
    : '拖拽旋转视角，滚轮缩放；点击地面丢一个布娃娃',
);

function flash(message: string): void {
  toastQueue.push(message);
  // 立刻同步一次：push 之后队首可能还是上一条（上一条还没到期），
  // 这时不该抢显示权，等它过期自然会轮到新的
  toast.value = toastQueue.peek() ?? '';
}

function refreshHud(): void {
  Object.assign(hud, sim.hud());

  // 小地图：先按当前效率标脏，脏了才真正上传像素（稳态下 10Hz 里只会有 1~2 次重绘）
  sim.refreshMinimap();
  const mini = minimapEl.value;
  if (mini !== null && sim.minimap.isDirty) sim.minimap.blit(mini);

  const notice = sim.takeBlockedNotice();
  if (notice !== '') flash(notice);

  Object.assign(streamStats, sim.streamStats());
  refreshLabelText();
  // 速度可能被按钮改过；每 10Hz 对齐一次滑块，避免面板与真实状态漂移
  if (showDiag.value) syncKnobs();
}

/** 把元素内坐标（CSS 像素）转成格子。InputManager 给的坐标已经是元素内坐标。 */
function cellAtPoint(x: number, y: number): { col: number; row: number } | null {
  if (view2d === null) return null;
  const world = view2d.screenToWorld(x, y);
  return cellFromWorld(world.x, world.y);
}

function highlightCell(col: number, row: number): void {
  if (view2d === null) return;
  // 流式加载的焦点跟着指针：走到哪儿，附近哪几块常驻
  sim.focusAt(indexOf(col, row));
  const rect = cellRect(col, row);
  const occupied = sim.cellAt(col, row) !== 0;
  view2d.setHighlight({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: tool.value === 'remove' ? 0xff6b6b : occupied ? 0xffd166 : 0x8de1ff,
  });
}

function buildAt(col: number, row: number): void {
  const result = sim.build(col, row, tool.value);
  flash(result.message);
  if (!result.ok) return;
  refreshHud();
  syncCity();
}

/**
 * 3D 里丢一个布娃娃。
 *
 * 坐标从 NDC 换算，并夹在物理世界边界内（z 边界 ±6）——
 * 否则拖到画面边缘松手时，布娃娃会生成在界外直接掉出去，看起来像"没生成"。
 */
function dropRagdoll(ndcX: number, ndcZ: number): void {
  if (engine === null) return;
  const x = Math.max(-12, Math.min(12, ndcX * 12));
  const z = Math.max(-5, Math.min(5, ndcZ * 5));
  ragdollSeq += 1;
  const id = `rag-${ragdollSeq}`;
  const ragdoll = engine.world.spawnHumanoid(id, x, 12, z, 1);
  ragdoll.addRadialImpulse(x, 12, z, 3, 6);
  ragdollIds.push(id);
  while (ragdollIds.length > engine.profile.maxRagdolls) {
    const oldest = ragdollIds.shift();
    if (oldest !== undefined) engine.world.removeRagdoll(oldest);
  }
  flash('放了一个布娃娃');
}

/** 双指捏合的起始间距。用它算 scale，比累乘每帧比值稳定。 */
let pinchBase = 0;

let input2d: InputManager | null = null;
let input3d: InputManager | null = null;

/**
 * 3D 浮动标签桥。
 *
 * 每帧把建筑的头顶坐标投影成屏幕坐标，再直接写 DOM 的 `transform`
 * （不进 Vue 响应式：20 个标签 × 60fps 的响应式更新会把 CPU 预算吃光）。
 *
 * 元素的创建/复用/隐藏交给 `@tabby/ui` 的 `LabelPool`：它按 index 池化，
 * 位置每帧写、文字走差异比较，本帧用不到的标签用 `visibility` 藏起来
 * （那是重绘不是重排，比 `display: none` 便宜）。
 */
const renderBridge = new RenderBridge({ minSeparation: 46, occlusionBias: 0.4 });
let labelPool: LabelPool | null = null;
/**
 * 标签文字缓存。
 *
 * 文字 10Hz 变一次、位置每帧变，所以两者分开算：`refreshLabelText` 只改这两条数组，
 * `syncLabels` 每帧把它们拼进 `LabelVisual` 交给池子。分开之后
 * 「文字没变就不碰 DOM」这条优化才有地方落脚。
 */
const labelTexts: string[] = [];
const labelBad: boolean[] = [];
let labelSyncCount = 0;

function drawBox2D(spec: BoxSpec): void {
  view2d?.upsertBox(`${spec.x.toFixed(2)}:${spec.y.toFixed(2)}`, spec);
}

/** 把投影重建成渲染几何。只在格子变化 / 切模式 / 读档时调用，不进每帧路径。 */
function syncCity(): void {
  if (engine === null || view2d === null || view3d === null) return;
  const cells = sim.cells;
  const zones = zonesOf(cells);
  engine.setStaticGeometry(obstaclesOf(cells), zones);

  view2d.clearBoxes();
  drawBox2D({
    x: TOWER.x,
    y: TOWER.y,
    width: TOWER.width,
    height: TOWER.height,
    color: 0x3f7ec9,
  });

  const specs3d: Box3DSpec[] = [
    { id: 'tower', x: TOWER.x, y: 0, z: 1.2, width: TOWER.width, height: TOWER.height, depth: 2.4, color: 0x3f7ec9 },
    { id: 'mill-pole', x: 8.1, y: 0, z: -5.6, width: 0.8, height: 6.2, depth: 0.8, color: 0x556377 },
  ];
  drawBox2D({ x: 8.1, y: 0, width: 0.8, height: 6.2, color: 0x556377 });

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const kind = sim.cellAt(col, row);
      if (kind === 0) continue;
      const rect = cellRect(col, row);
      const height = CELL_HEIGHT[kind] ?? CELL_SIZE;
      drawBox2D({ x: rect.x, y: rect.y, width: rect.width, height, color: CELL_COLOR[kind] ?? 0xffffff });
      // 2D 的 rect.y 是「行纵深」，3D 里必须落到 z 轴；直接当 y 用会让建筑悬空
      specs3d.push({
        id: `cell-${col}-${row}`,
        x: rect.x,
        y: 0,
        z: zSpanOf(row).min,
        width: rect.width * 0.94,
        height,
        depth: CELL_SIZE * 0.94,
        color: CELL_COLOR[kind] ?? 0xffffff,
      });
    }
  }
  view3d.setBoxes(specs3d);
  prevZones = new Array<number>(zones.length).fill(0);
  syncLabelsAndOccluders();
}

/**
 * 重建浮动标签与遮挡体。
 *
 * 只在城市变化时重建（建造/拆除/读档），不是每帧：标签内容是"这栋楼的物流效率"，
 * 而效率一天才变一次 —— 每帧重建等于每帧做 20 次图查询。
 * 数字更新由 `refreshLabelText()` 在 HUD 刷新（10Hz）时完成。
 */
function syncLabelsAndOccluders(): void {
  renderBridge.clearLabels();
  const occluders: OccluderBox[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const z = zSpanOf(row);
    for (let col = 0; col < GRID_COLS; col += 1) {
      const kind = sim.cellAt(col, row);
      if (kind === 0) continue;
      const rect = cellRect(col, row);
      const height = CELL_HEIGHT[kind] ?? CELL_SIZE;
      occluders.push({
        minX: rect.x,
        minY: 0,
        minZ: z.min,
        maxX: rect.x + rect.width,
        maxY: height,
        maxZ: z.max,
      });
      if (kind === 1) {
        // 只有住宅挂名字牌；农田挂"效率"牌（它的产出受物流影响）
        renderBridge.addLabel({
          id: `house-${col}-${row}`,
          x: rect.x + rect.width / 2,
          y: height + 0.9,
          z: (z.min + z.max) / 2,
          kind: 'house',
          priority: 1,
        });
      } else if (kind === 2) {
        renderBridge.addLabel({
          id: `farm-${col}-${row}`,
          x: rect.x + rect.width / 2,
          y: height + 1.2,
          z: (z.min + z.max) / 2,
          kind: 'farm',
          priority: 2,
        });
      }
    }
  }
  renderBridge.setOccluders(occluders);
  refreshLabelText();
}

/** 更新标签文字（10Hz 跟随 HUD，不进每帧路径）。 */
function refreshLabelText(): void {
  const labels = renderBridge.labels;
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label === undefined) continue;
    const id = label.id;
    if (id.startsWith('farm-')) {
      const [col, row] = id.slice(5).split('-').map(Number) as [number, number];
      const entity = sim.entityOfTile(indexOf(col, row));
      const eff = entity >= 0 ? sim.roads.logistics.efficiencyOf(entity, sim.city) : 1;
      labelTexts[i] = eff <= 0.01 ? '断供' : `效率 ${Math.round(eff * 100)}%`;
      labelBad[i] = eff <= 0.01;
    } else {
      labelTexts[i] = '住宅';
      labelBad[i] = false;
    }
  }
}

/**
 * 输入接线。
 *
 * 2D 与 3D 各一个 `InputManager`：两个 canvas 叠在同一位置，但手势语义完全不同
 * （2D 是"点格子"，3D 是"转相机"）。共用一个会让「3D 里拖动」在 2D 层也触发点击。
 *
 * 2D 用 `longpress` 做拆除：既省一个工具栏状态，又顺便验证长按识别。
 */
function bindInput(): void {
  if (canvas2d.value === null || canvas3d.value === null) return;

  input2d = new InputManager(canvas2d.value);
  input2d.on((event) => {
    if (event.kind === 'move') {
      const cell = cellAtPoint(event.sample.x, event.sample.y);
      if (cell === null) view2d?.setHighlight(null);
      else highlightCell(cell.col, cell.row);
      return;
    }
    if (event.kind === 'tap' && mode.value === '2d') {
      const cell = cellAtPoint(event.data.x, event.data.y);
      if (cell !== null) buildAt(cell.col, cell.row);
      return;
    }
    if (event.kind === 'longpress' && mode.value === '2d') {
      // 长按拆除：与工具栏的「拆除」等价，但少一次点击
      const cell = cellAtPoint(event.data.x, event.data.y);
      if (cell !== null && sim.cellAt(cell.col, cell.row) !== 0) {
        const result = sim.build(cell.col, cell.row, 'remove');
        flash(result.message);
        if (result.ok) {
          refreshHud();
          syncCity();
        }
      }
    }
  });

  input3d = new InputManager(canvas3d.value);
  const orbit = view3d?.orbitController;
  input3d.on((event) => {
    const driver = orbit?.orbitDriver;
    if (driver === undefined) return;
    switch (event.kind) {
      case 'tap':
        // 点击丢布娃娃：只有真正的点（没拖动过）才触发，否则转相机会顺手丢一堆
        if (mode.value === '3d' && canvas3d.value !== null) {
          const rect = canvas3d.value.getBoundingClientRect();
          const nx = (event.data.x / rect.width) * 2 - 1;
          const nz = (event.data.y / rect.height) * 2 - 1;
          dropRagdoll(nx, nz);
        }
        break;
      case 'dragstart':
        driver.stop(); // 抓住画面：先停住惯性
        break;
      case 'drag':
        driver.drag(event.data.dx, event.data.dy);
        break;
      case 'dragend':
        // 松手时把速度交给 driver 开惯性；帧率无关的衰减在 OrbitDriver 里
        driver.release(event.data.vx, event.data.vy);
        break;
      case 'pinchstart':
        pinchBase = event.data.distance;
        break;
      case 'pinch':
        driver.pinch(pinchBase > 0 ? event.data.distance / pinchBase : 1, driver.state.distance);
        break;
      case 'rotate':
        driver.twist(event.data.delta);
        break;
      case 'pan2':
        driver.pan(event.data.dx, event.data.dy);
        break;
      case 'wheel':
        driver.wheel(event.data.deltaY);
        break;
      default:
        break;
    }
  });
}

function setMode(next: '2d' | '3d'): void {
  const target = next === '2d' ? 'render2d' : 'render3d';
  if (engine !== null && engine.failedViewIds.includes(target)) {
    flash(`${target} 在当前设备不可用（WebGL2 上下文创建失败）`);
    return;
  }
  mode.value = next;
  engine?.setActiveView(target);
}

function setSpeed(next: 1 | 2 | 4): void {
  speed.value = next;
  sim.setSpeed(next);
  knobValues.speed = next;
}

/** 每固定步调用：水塔出水、烟囱冒烟、灌溉结算、经济结算。 */
function onFixed(dt: number): void {
  if (engine === null) return;

  waterTimer += dt;
  if (waterTimer >= 0.05) {
    waterTimer = 0;
    const capacity = engine.profile.fluidParticles;
    if (engine.fluidCount < capacity * 0.82) {
      const col = WATER_COLS[waterSeq % WATER_COLS.length] ?? 0;
      waterSeq += 1;
      const z = zSpanOf(FARM_ROW);
      engine.spawnFluid(
        2,
        WORLD_MIN_X + col * CELL_SIZE + CELL_SIZE / 2,
        TOWER.height - 0.6,
        (z.min + z.max) / 2,
        0.3,
      );
    }
  }

  smokeTimer += dt;
  // 1 秒一股、每股 1 粒：5 栋住宅时屏上稳定十几粒。
  // 曾经是 0.4 秒 2 粒，2D 视角下烟雾糊成一片，把建筑本身挡住 —— 视觉效果比"信息量"重要。
  if (smokeTimer >= 1) {
    smokeTimer = 0;
    for (let col = 0; col < GRID_COLS; col += 1) {
      for (let row = 0; row < GRID_ROWS; row += 1) {
        if (sim.cellAt(col, row) !== 1) continue;
        const rect = cellRect(col, row);
        engine.world.smoke.emit(rect.x + 1, rect.y + CELL_SIZE + 0.2, 0, 1, 0.3);
      }
    }
  }

  // 吸收区计数是累计值，取增量而不是当前值 —— 直接传当前值会让灌溉收益随粒子数抖动
  const zones = engine.zoneCounts;
  let absorbed = 0;
  for (let i = 0; i < zones.length; i += 1) {
    const current = zones[i] ?? 0;
    const previous = prevZones[i] ?? 0;
    absorbed += Math.max(0, current - previous);
    prevZones[i] = current;
  }
  if (absorbed > 0) sim.irrigate(absorbed);

  // 经济内核的唯一时间入口。dt 是固定步长（1/60 秒），乘 1000 换成毫秒。
  if (sim.advance(dt * 1000)) flash('月末结算：税收已入库');

  pendulumTimer += dt;
  const mill = engine.world.getPendulum('mill');
  if (mill !== null && pendulumTimer >= 3) {
    pendulumTimer = 0;
    mill.angularVelocity += 1.6;
  }
}

/**
 * 刷新 3D 浮动标签。
 *
 * 遮挡判定用「相机 → 标签」射线与建筑 AABB 求交（在 `RenderBridge` 里）。
 * 这是 3D UI 最容易穿帮的地方：被楼挡住的血条照样画在楼前面。
 */
function syncLabels(): void {
  const host = overlayEl.value;
  if (host === null || view3d === null) return;
  const labels3d = view3d.cameraMatrices;
  const pool = labelPool;
  if (labels3d === null || mode.value !== '3d' || pool === null) {
    pool?.hideAll();
    return;
  }

  const labels = renderBridge.update(labels3d, { width: host.clientWidth, height: host.clientHeight });
  // 每帧重建这个小数组是唯一可接受的分配：它的长度就是当前城市里的建筑数（≤72），
  // 而池子内部的元素是完全复用的 —— 真正贵的那部分没有分配。
  const visual: LabelVisual[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label === undefined) continue;
    visual.push({
      x: label.x,
      y: label.y,
      scale: label.scale,
      visible: label.visible,
      text: labelTexts[i] ?? '',
      bad: labelBad[i] === true,
    });
  }
  pool.apply(visual);
  labelSyncCount += 1;
}

function onFrame(): void {
  if (engine === null) return;
  frameCounter += 1;
  // 6 帧一次 ≈ 10Hz：HUD 数字跳得太快反而读不清
  if (frameCounter % 6 !== 0) return;
  const s = engine.stats;
  stats.fps = s.fps;
  stats.cpu = s.cpuMs;
  stats.fluid = s.fluidParticles;
  stats.smoke = s.smokeParticles;
  stats.draw = s.drawCallsHint;
  stats.mode = engine.host.mode;
  stats.tier = engine.tier;
  sim.streamStep();
  refreshHud();
  syncLabels();
  // toast 也走 10Hz：队首到期后队列会顶上下一条，变了才写 ref
  if (toastQueue.prune()) toast.value = toastQueue.peek() ?? '';
  if (showDiag.value) diagText.value = collectDiagnostics();
}

function collectDiagnostics(): string {
  if (engine === null) return '引擎未就绪';
  const d = sim.diagnostics();
  const projection = sim.verifyProjection();
  const h = sim.hud();
  const priceNote = h.foodPrice <= 1.51 ? '（已触 0.3× 基准下限）' : '';
  const quality = view3d?.qualityInfo ?? null;
  return [
    engine.getDiagnostics().report,
    '── 经济内核 ──',
    `日期      ${d.year} 年 ${d.month} 月 ${d.day} 日 · tick ${d.tick}`,
    `实体      ${d.aliveBuildings} 存活 / ${sim.economy.state.capacity} 上限`,
    `人口      ${d.totalPopulation.toFixed(2)} · 住房 ${h.housing} · 岗位 ${h.jobs}`,
    `产耗      食物 产 ${h.foodProduced.toFixed(1)} / 耗 ${h.foodConsumed.toFixed(1)} 每 tick`,
    `粮价      ${d.prices.map((p) => p.toFixed(2)).join(' / ')}${priceNote}`,
    `GDP       ${d.gdp.toFixed(1)} · 货币 ${d.moneySupply}`,
    `膨胀指数  ${d.inflationRatio.toFixed(3)}`,
    `日结算    ${d.lastDayMs.toFixed(3)} ms · 月结算 ${d.lastMonthMs.toFixed(3)} ms`,
    `灌溉累计  ${sim.waterIncome} 金币`,
    '── 物流 ──',
    `生产建筑  ${h.supplyBuildings} 座 · 断供 ${h.blockedBuildings} 座`,
    `路网站点  ${sim.roads.graph.nodeCount} 节点 / ${sim.roads.graph.edgeCount} 有向边`,
    `路障      挡板 ${h.roadBlocks} 处 · 枢纽格 ${HUB_TILE}`,
    `图缓存    ${sim.roads.network.cachedSources} 棵最短路树 · 待算 ${sim.roads.network.pendingSources}`,
    '── 分块流式 ──',
    `常驻块    ${streamStats.resident} / ${streamStats.total}（累计加载 ${streamStats.loads}、卸载 ${streamStats.unloads}）`,
    `存档体积  经济层 ${sim.economy.save().byteLength}B + 地图分块 ${sim.worldArchiveInfo().bytes}B（${sim.worldArchiveInfo().chunks} 块）`,
    `小地图    缩略图 ${sim.minimap.redraws} 次重绘`,
    '── 画质与稳定性 ──',
    quality === null
      ? '3D 视图未挂载'
      : `分辨率    DRS ×${quality.drsScale.toFixed(2)} · 缓冲 ${quality.bufferWidth}×${quality.bufferHeight}（帧中位数 ${quality.medianFrameMs.toFixed(1)}ms，调整 ${quality.adjustments} 次）`,
    quality === null ? '' : `阴影      ${quality.shadowReason}`,
    quality === null ? '' : `建筑 LOD  近 ${quality.lodNear} / 远 ${quality.lodFar} / 剔除 ${quality.lodCulled}`,
    quality === null
      ? ''
      : `上下文    丢失 ${quality.contextLost} 次 · 恢复 ${quality.contextRestored} 次${quality.textureError === null ? '' : ` · 纹理加载失败：${quality.textureError}`}`,
    '── 配置表 ──',
    configStatus.value,
    `投影自检  ${projection.ok ? '✓' : '✗'} ${projection.detail}`,
  ].join('\n');
}

/**
 * 重读 `public/config/table.json`。
 *
 * 校验不过时**不重建世界** —— 只把错误原文显示在配置状态里。
 * 这是热重载最重要的性质：改表改到一半保存，页面不能炸。
 */
async function reloadConfig(): Promise<void> {
  const result = await configHost.reload();
  configStatus.value = result.ok
    ? `配置：${result.source === 'override' ? '覆盖表' : '内置表'} · ${result.message}`
    : `配置校验失败（保留旧表）\n${result.message}`;
  if (!result.ok) flash('配置表校验失败，已保留旧配置');
  else flash(result.changed ? '配置表已生效，世界已重建' : '配置表无变化');
}

/** 用当前配置表重建整个仿真层。热重载后必须走这条路径才能让新数值生效。 */
function restartWorld(): void {
  const next = new CitySimulation(0, configHost.table);
  sim = next;
  next.beginStreaming();
  Object.assign(hud, next.hud());
  streamStats.enabled = true;
  bindKnobs();
  syncCity();
  refreshHud();
  flash('世界已按当前配置表重建');
}

function onConfigChanged(): void {
  configStatus.value = `配置：${configHost.result.message}`;
  // 只有真的换了表才会走到这里（ConfigHost 用 changed 区分「能用」和「变了」）
  // 表变了，旧实例里的建筑下标/造价全部可能失效 —— 必须重建，不能热改
  restartWorld();
}

const unsubscribeConfig = configHost.subscribe(onConfigChanged);

function saveGame(): void {
  flash(sim.saveToStorage() ? '已存档到本地' : '存档失败（可能是隐私模式禁用了 localStorage）');
}

function loadGame(): void {
  if (!sim.loadFromStorage()) {
    flash('没有可用存档');
    return;
  }
  // 读档是批量替换：投影已由 loadFromStorage 重建，这里只需刷新几何与 HUD
  refreshHud();
  syncCity();
  flash('读档完成');
}

onMounted(async () => {
  if (canvas2d.value === null || canvas3d.value === null || stageEl.value === null) return;

  view2d = new Renderer2DView({ canvas: canvas2d.value });
  // 输入统一由 @tabby/input 的 InputManager 处理，视图不能再自己绑一份
  view3d = new Renderer3DView({ canvas: canvas3d.value, manageInput: false });
  // 标签池必须晚于 overlay 元素存在（v-if 里没它，ref 在 mounted 时已就绪）
  if (overlayEl.value !== null) labelPool = new LabelPool(overlayEl.value);

  engine = await Engine.create({
    bounds: BOUNDS,
    views: [view3d, view2d],
    // 能力探测用独立 1x1 canvas：复用主 canvas 会固定住 WebGL 上下文属性，
    // 导致 Three 拿不到 depth/stencil buffer。
    probeCanvas: null,
    workerFactory: () => new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' }),
  });

  // 测试用例的调试入口：控制台可直接读状态
  (window as unknown as { __tabby?: Engine }).__tabby = engine;
  (window as unknown as { __tabby3d?: unknown }).__tabby3d = {
    debug: () => view3d?.debugInfo,
    sim,
    hud: () => sim.hud(),
    projection: () => sim.verifyProjection(),
  };
  animation.attach(engine);
  engine.bus.on('fixed', ({ dt }) => onFixed(dt));
  engine.bus.on('frame', () => onFrame());
  engine.bus.on('degrade', ({ reason }) => {
    flash(`画质自动降级：${reason}`);
  });
  engine.bus.on('view-error', ({ viewId, message }) => {
    flash(`${viewId} 初始化失败，已跳过（${message.slice(0, 40)}）`);
  });

  // 开局先扔两个布娃娃：切到 3D 页立刻能看出物理在跑，不用先点一下
  ragdollSeq = 2;
  for (const [index, seedX] of [-3.4, 2.8].entries()) {
    const seedZ = -1.2 + index * 2.6;
    const seedId = `rag-${index + 1}`;
    const ragdoll = engine.world.spawnHumanoid(seedId, seedX, 9.5, seedZ, 0.9);
    ragdoll.addRadialImpulse(seedX, 9.5, seedZ, 2.2, 4.5);
    ragdollIds.push(seedId);
  }

  engine.world.addPendulum('mill', { length: 2.4, gravity: 9.8, damping: 0.12, angle: 1.1 });
  view3d.bindSpinners([
    { id: 'mill', pendulumId: 'mill', x: 8.5, y: 6.2, z: -5.2, radius: 2.4, thickness: 0.28, color: 0xd9a441 },
  ]);

  sim.setSpeed(speed.value);
  sim.beginStreaming();
  streamStats.enabled = true;
  bindKnobs();
  syncCity();
  refreshHud();
  sim.minimap.invalidate();
  if (minimapEl.value !== null) sim.minimap.blit(minimapEl.value);
  setMode('2d');

  // 覆盖表存在且合法才替换世界；大多数构建里没有这个文件，会安静地回退到内置表
  const loaded = await configHost.reload();
  configStatus.value = loaded.ok
    ? `配置：${loaded.source === 'override' ? '覆盖表' : '内置表'} · ${loaded.message}`
    : `配置校验失败（保留旧表）\n${loaded.message}`;

  bindInput();

  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry === undefined || engine === null) return;
    const box = entry.contentRect;
    if (box.width < 8 || box.height < 8) return;
    engine.resize(box.width, box.height);
  });
  resizeObserver.observe(stageEl.value);

  const box = stageEl.value.getBoundingClientRect();
  engine.resize(box.width, box.height);

  gsap.from('.toolbar button', { y: 18, opacity: 0, stagger: 0.05, duration: 0.5, ease: 'power3.out' });
  flash('引擎就绪，水塔正在出水');
});

onBeforeUnmount(() => {
  unsubscribeConfig();
  resizeObserver?.disconnect();
  resizeObserver = null;
  input2d?.dispose();
  input3d?.dispose();
  input2d = null;
  input3d = null;
  animation.dispose();
  labelPool?.dispose();
  labelPool = null;
  (window as unknown as { __tabby?: Engine }).__tabby = undefined;
  engine?.dispose();
  engine = null;
  view2d = null;
  view3d = null;
});
</script>

<template>
  <div class="app">
    <header class="hud">
      <div class="brand">
        <span class="logo">◈</span>
        <div>
          <strong>Tabby Engine</strong>
          <em>移动端优先 · WebGL2 · 自研物理</em>
        </div>
      </div>
      <div class="badges">
        <span class="badge tier" :data-tier="stats.tier">{{ stats.tier }}</span>
        <span class="badge">{{ stats.fps.toFixed(0) }} fps</span>
        <span class="badge">CPU {{ stats.cpu.toFixed(1) }}ms</span>
        <span class="badge">水粒子 {{ stats.fluid }}</span>
        <span class="badge">烟雾 {{ stats.smoke }}</span>
        <span class="badge">{{ stats.mode }}</span>
      </div>
      <button class="ghost" type="button" @click="showDiag = !showDiag">
        {{ showDiag ? '收起诊断' : '诊断' }}
      </button>
    </header>

    <main class="stage-wrap">
      <div ref="stageEl" class="stage">
        <canvas ref="canvas3d" class="layer" :class="{ visible: mode === '3d' }" />
        <div ref="overlayEl" class="label-layer" />
        <canvas ref="canvas2d" class="layer" :class="{ visible: mode === '2d' }" />
        <div class="mode-switch">
          <button type="button" :class="{ on: mode === '2d' }" @click="setMode('2d')">2D 经营</button>
          <button type="button" :class="{ on: mode === '3d' }" @click="setMode('3d')">3D 试验场</button>
        </div>
        <transition name="fade">
          <div v-if="toast" class="toast">{{ toast }}</div>
        </transition>
      </div>
    </main>

    <footer class="dock">
      <div class="statusbar">
        <div class="coins">
          <span>💰</span>
          <b>{{ hud.treasury }}</b>
        </div>
        <canvas
          ref="minimapEl"
          class="minimap"
          :title="`小地图：金格=市政厅，暗红=断供。常驻 ${streamStats.resident}/${streamStats.total} 块`"
        />
        <ul class="readouts">
          <li><em>日期</em>{{ hud.year }} 年 {{ hud.month }} 月 {{ hud.day }} 日</li>
          <li><em>人口</em>{{ hud.population }} / {{ hud.housing }}</li>
          <li><em>就业</em>{{ hud.employed }} / {{ hud.jobs }}</li>
          <li :class="{ bad: hud.starving }"><em>满意</em>{{ pct(hud.satisfaction) }}</li>
          <li><em>存粮</em>{{ hud.foodStock.toFixed(0) }} <small>产 {{ hud.foodProduced.toFixed(0) }}/日</small></li>
          <li><em>灌溉</em>{{ hud.waterIncome }} <small>金币</small></li>
          <li><em>建筑</em>房 {{ hud.houseCount }} · 田 {{ hud.farmCount }} · 墙 {{ hud.wallCount }}</li>
          <li :class="{ bad: hud.blockedBuildings > 0 }">
            <em>物流</em>{{ hud.supplyBuildings - hud.blockedBuildings }} / {{ hud.supplyBuildings }} 通
            <small v-if="hud.blockedBuildings > 0">断 {{ hud.blockedBuildings }}</small>
          </li>
        </ul>
      </div>

      <div class="toolbar">
        <div class="tools">
          <button
            v-for="item in TOOLS"
            :key="item"
            type="button"
            :class="{ on: tool === item }"
            @click="tool = item"
          >
            {{ TOOL_LABEL[item] }}
            <small v-if="item !== 'remove'">{{ costOf(item) }}</small>
          </button>
        </div>
        <div class="speeds">
          <button
            v-for="level in [1, 2, 4] as const"
            :key="level"
            type="button"
            :class="{ on: speed === level }"
            @click="setSpeed(level)"
          >
            ×{{ level }}
          </button>
        </div>
        <div class="saves">
          <button type="button" @click="saveGame">存档</button>
          <button type="button" @click="loadGame">读档</button>
        </div>
        <p class="hint">{{ hint }}</p>
      </div>
    </footer>

    <aside v-if="showDiag" class="diag">
      <div class="diag-actions">
        <button type="button" @click="reloadConfig">重读配置表</button>
        <button type="button" @click="restartWorld">重建世界</button>
        <button type="button" @click="syncKnobs">重读参数</button>
      </div>
      <div class="knobs">
        <label v-for="knob in knobSpecs" :key="knob.id" :title="knob.hint">
          <span class="knob-name">{{ knob.label }}</span>
          <input
            type="range"
            :min="knob.min"
            :max="knob.max"
            :step="knob.step"
            :value="knobValues[knob.id] ?? knob.min"
            @input="applyKnob(knob.id, Number(($event.target as HTMLInputElement).value))"
          />
          <b>{{ knob.format(knobValues[knob.id] ?? knob.min) }}</b>
          <em v-if="knobFeedbacks[knob.id]">{{ knobFeedbacks[knob.id] }}</em>
        </label>
      </div>
      <pre>{{ diagText || '采集中…' }}</pre>
    </aside>
  </div>
</template>
