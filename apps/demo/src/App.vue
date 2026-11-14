<script setup lang="ts">
import { AnimationSystem } from '@tabby/animation';
import { Engine } from '@tabby/engine';
import type { PhysicsBounds } from '@tabby/physics';
import { Renderer2DView, type BoxSpec } from '@tabby/render2d';
import { Renderer3DView, type Box3DSpec } from '@tabby/render3d';
import { gsap } from 'gsap';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
  CELL_COLOR,
  CELL_HEIGHT,
  CELL_SIZE,
  GRID_COLS,
  GRID_ROWS,
  TOWER,
  WORLD_MIN_X,
  cellFromWorld,
  cellRect,
  obstaclesOf,
  zSpanOf,
  zonesOf,
} from './game/city';
import { CitySimulation, TOOLS, TOOL_LABEL, costOf, type ToolKind } from './game/simulation';
import { configHost } from './game/config-loader';
import { HUB_TILE } from './game/logistics';
import { indexOf } from './game/city';

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

const mode = ref<'2d' | '3d'>('2d');
const tool = ref<ToolKind>('house');
const speed = ref<1 | 2 | 4>(2);
const toast = ref('欢迎来到 Tabby Engine 测试用例');
const showDiag = ref(false);
const diagText = ref('');

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
  toast.value = message;
  window.setTimeout(() => {
    if (toast.value === message) toast.value = '';
  }, 1800);
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
}

function cellFromPointer(event: PointerEvent): { col: number; row: number } | null {
  if (view2d === null || canvas2d.value === null) return null;
  const rect = canvas2d.value.getBoundingClientRect();
  const world = view2d.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  return cellFromWorld(world.x, world.y);
}

function onPointerMove2D(event: PointerEvent): void {
  if (view2d === null) return;
  const cell = cellFromPointer(event);
  if (cell === null) {
    view2d.setHighlight(null);
    return;
  }
  // 流式加载的焦点跟着指针：走到哪儿，附近哪几块常驻
  sim.focusAt(indexOf(cell.col, cell.row));
  const rect = cellRect(cell.col, cell.row);
  const occupied = sim.cellAt(cell.col, cell.row) !== 0;
  view2d.setHighlight({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: tool.value === 'remove' ? 0xff6b6b : occupied ? 0xffd166 : 0x8de1ff,
  });
}

function onPointerDown2D(event: PointerEvent): void {
  const cell = cellFromPointer(event);
  if (cell === null) return;
  const result = sim.build(cell.col, cell.row, tool.value);
  flash(result.message);
  if (!result.ok) return;
  refreshHud();
  syncCity();
}

function onPointerDown3D(event: PointerEvent): void {
  if (engine === null || view3d === null) return;
  const rect = canvas3d.value?.getBoundingClientRect();
  if (rect === undefined) return;
  const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const nz = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  // 限制在物理世界内（z 边界 ±6），否则布娃娃会生成在界外直接掉出去
  const x = nx * 12;
  const z = nz * 5;
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
  if (showDiag.value) diagText.value = collectDiagnostics();
}

function collectDiagnostics(): string {
  if (engine === null) return '引擎未就绪';
  const d = sim.diagnostics();
  const projection = sim.verifyProjection();
  const h = sim.hud();
  const priceNote = h.foodPrice <= 1.51 ? '（已触 0.3× 基准下限）' : '';
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
  view3d = new Renderer3DView({ canvas: canvas3d.value });

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

  canvas2d.value.addEventListener('pointermove', onPointerMove2D);
  canvas2d.value.addEventListener('pointerdown', onPointerDown2D);
  canvas3d.value.addEventListener('pointerdown', onPointerDown3D);

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
  canvas2d.value?.removeEventListener('pointermove', onPointerMove2D);
  canvas2d.value?.removeEventListener('pointerdown', onPointerDown2D);
  canvas3d.value?.removeEventListener('pointerdown', onPointerDown3D);
  animation.dispose();
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
      </div>
      <pre>{{ diagText || '采集中…' }}</pre>
    </aside>
  </div>
</template>
