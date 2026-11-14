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
  CELL_SIZE,
  COSTS,
  GRID_COLS,
  GRID_ROWS,
  TOOL_LABEL,
  TOWER,
  WORLD_MIN_X,
  WORLD_MIN_Y,
  applyTool,
  cellAt,
  cellRect,
  createCity,
  obstaclesOf,
  zonesOf,
  type CityState,
  type ToolKind,
} from './game/city';

const BOUNDS: PhysicsBounds = { min: { x: -14, y: 0, z: -6 }, max: { x: 14, y: 16, z: 6 } };
const TOOLS: readonly ToolKind[] = ['house', 'farm', 'wall', 'remove'];

const stageEl = ref<HTMLDivElement | null>(null);
const canvas2d = ref<HTMLCanvasElement | null>(null);
const canvas3d = ref<HTMLCanvasElement | null>(null);

const mode = ref<'2d' | '3d'>('2d');
const tool = ref<ToolKind>('house');
const city = reactive<CityState>(createCity());
const toast = ref('欢迎来到 Tabby Engine 测试用例');
const showDiag = ref(false);
const diagText = ref('');

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
let smokeTimer = 0;
let economyTimer = 0;
let pendulumTimer = 0;
let absorbedTotal = 0;
let ragdollSeq = 0;
const ragdollIds: string[] = [];
let prevZones: number[] = [];

const hint = computed(() =>
  mode.value === '2d'
    ? `点击网格建造${TOOL_LABEL[tool.value]}（${COSTS[tool.value]} 金币），挡板可以把水导进农田`
    : '拖拽旋转视角，滚轮缩放；点击地面丢一个布娃娃',
);

const coins = computed(() => Math.floor(city.coins));

function flash(message: string): void {
  toast.value = message;
  window.setTimeout(() => {
    if (toast.value === message) toast.value = '';
  }, 1800);
}

function cellFromPointer(event: PointerEvent): { col: number; row: number } | null {
  if (view2d === null || canvas2d.value === null) return null;
  const rect = canvas2d.value.getBoundingClientRect();
  const world = view2d.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const col = Math.floor((world.x - WORLD_MIN_X) / CELL_SIZE);
  const row = Math.floor((world.y - WORLD_MIN_Y) / CELL_SIZE);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null;
  return { col, row };
}

function onPointerMove2D(event: PointerEvent): void {
  if (view2d === null) return;
  const cell = cellFromPointer(event);
  if (cell === null) {
    view2d.setHighlight(null);
    return;
  }
  const rect = cellRect(cell.col, cell.row);
  const kind = cellAt(city, cell.col, cell.row);
  view2d.setHighlight({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: tool.value === 'remove' ? 0xff6b6b : kind === 'empty' ? 0x8de1ff : 0xffd166,
  });
}

function onPointerDown2D(event: PointerEvent): void {
  const cell = cellFromPointer(event);
  if (cell === null) return;
  const result = applyTool(city, cell.col, cell.row, tool.value);
  flash(result.message);
  if (result.ok) {
    city.cells = [...city.cells];
    syncCity();
  }
}

function onPointerDown3D(event: PointerEvent): void {
  if (engine === null || view3d === null) return;
  const rect = canvas3d.value?.getBoundingClientRect();
  if (rect === undefined) return;
  const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const nz = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  const x = nx * 10;
  const z = nz * 8;
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

function syncCity(): void {
  if (engine === null || view2d === null || view3d === null) return;
  engine.setStaticGeometry(obstaclesOf(city), zonesOf(city));

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
    { id: 'mill-pole', x: 8.1, y: 0, z: -9, width: 0.8, height: 6.2, depth: 0.8, color: 0x556377 },
  ];
  drawBox2D({ x: 8.1, y: 0, width: 0.8, height: 6.2, color: 0x556377 });

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const kind = cellAt(city, col, row);
      if (kind === 'empty') continue;
      const rect = cellRect(col, row);
      const height = kind === 'wall' ? 2 : kind === 'farm' ? 1.2 : CELL_SIZE;
      drawBox2D({ x: rect.x, y: rect.y, width: rect.width, height, color: CELL_COLOR[kind] });
      // 2D 的 rect.y 是"行"纵深，3D 里必须落到 z 轴；直接当 y 用会让建筑悬空。
      specs3d.push({
        id: `cell-${col}-${row}`,
        x: rect.x,
        y: 0,
        z: -4 + row * CELL_SIZE,
        width: rect.width * 0.94,
        height,
        depth: CELL_SIZE * 0.94,
        color: CELL_COLOR[kind],
      });
    }
  }
  view3d.setBoxes(specs3d);
  prevZones = new Array<number>(zonesOf(city).length).fill(0);
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

/** 每固定步调用：水塔出水、烟囱冒烟、经济结算。 */
function onFixed(dt: number): void {
  if (engine === null) return;

  waterTimer += dt;
  if (waterTimer >= 0.05) {
    waterTimer = 0;
    const capacity = engine.profile.fluidParticles;
    if (engine.fluidCount < capacity * 0.82) {
      engine.spawnFluid(3, TOWER.x + TOWER.width + 0.55, TOWER.height - 0.6, 0, 0.45);
    }
  }

  smokeTimer += dt;
  if (smokeTimer >= 0.4) {
    smokeTimer = 0;
    for (let col = 0; col < GRID_COLS; col += 1) {
      for (let row = 0; row < GRID_ROWS; row += 1) {
        if (cellAt(city, col, row) !== 'house') continue;
        const rect = cellRect(col, row);
        engine.world.smoke.emit(rect.x + 1, rect.y + CELL_SIZE + 0.2, 0, 2, 0.18);
      }
    }
  }

  const zones = engine.zoneCounts;
  let absorbed = 0;
  for (let i = 0; i < zones.length; i += 1) {
    const current = zones[i] ?? 0;
    const previous = prevZones[i] ?? 0;
    absorbed += Math.max(0, current - previous);
    prevZones[i] = current;
  }
  if (absorbed > 0) absorbedTotal += absorbed;
  for (let i = 0; i < city.farmWater.length; i += 1) {
    city.farmWater[i] = (city.farmWater[i] ?? 0) + absorbed / Math.max(1, city.farmWater.length);
  }

  economyTimer += dt;
  if (economyTimer >= 1) {
    economyTimer = 0;
    city.coins += city.houses * 2;
    while (absorbedTotal >= 25) {
      absorbedTotal -= 25;
      city.coins += 8;
    }
  }

  // 风车：真实单摆驱动，能量不足时补一脚，避免停摆后画面像卡住
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
  if (frameCounter % 6 !== 0) return;
  const s = engine.stats;
  stats.fps = s.fps;
  stats.cpu = s.cpuMs;
  stats.fluid = s.fluidParticles;
  stats.smoke = s.smokeParticles;
  stats.draw = s.drawCallsHint;
  stats.mode = engine.host.mode;
  stats.tier = engine.tier;
  if (showDiag.value) diagText.value = engine.getDiagnostics().report;
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
    { id: 'mill', pendulumId: 'mill', x: 8.5, y: 6.2, z: -8.6, radius: 2.4, thickness: 0.28, color: 0xd9a441 },
  ]);

  syncCity();
  setMode('2d');

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

    <footer class="toolbar">
      <div class="coins">
        <span>💰</span>{{ coins }}
        <small>房屋 {{ city.houses }} · 农田 {{ city.farms }}</small>
      </div>
      <div class="tools">
        <button
          v-for="item in TOOLS"
          :key="item"
          type="button"
          :class="{ on: tool === item }"
          @click="tool = item"
        >
          {{ TOOL_LABEL[item] }}
          <small v-if="item !== 'remove'">{{ COSTS[item] }}</small>
        </button>
      </div>
      <p class="hint">{{ hint }}</p>
    </footer>

    <aside v-if="showDiag" class="diag">
      <pre>{{ diagText || '采集中…' }}</pre>
    </aside>
  </div>
</template>
