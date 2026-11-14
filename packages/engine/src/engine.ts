import { EventBus, GameLoop, Profiler, type FrameInfo } from '@tabby/core';
import {
  DEFAULT_BOUNDS,
  PhysicsWorld,
  type Obstacle,
  type PhysicsBounds,
  type PhysicsStats,
} from '@tabby/physics';
import {
  canUseSharedPhysics,
  detectCapabilities,
  diagnose,
  formatCapabilityReport,
  profileFor,
  resolveTier,
  type DeviceTier,
  type DiagnosticIssue,
  type PlatformCapabilities,
  type QualityProfile,
  type TierDecision,
} from '@tabby/platform';
import { createFluidHost, type AbsorbZone, type FluidHost, type FluidHostStats } from '@tabby/worker';
import { AdaptiveGovernor, levelReason } from './adaptive.js';
import type { FrameStats, ViewAdapter } from './view.js';

export interface EngineOptions {
  /** 复用的 canvas，用于能力探测（避免多建一个 WebGL 上下文）。 */
  readonly probeCanvas?: HTMLCanvasElement | null;
  readonly bounds?: PhysicsBounds;
  readonly fixedDt?: number;
  readonly seed?: number;
  readonly views?: readonly ViewAdapter[];
  /** 由业务方提供的 worker 工厂，引擎不假设打包方式。 */
  readonly workerFactory?: (() => Worker) | null;
  readonly forceTier?: DeviceTier | null;
  readonly forceLocalPhysics?: boolean;
  /** 关闭自适应降级（调试用）。 */
  readonly disableAdaptive?: boolean;
}

export interface EngineEvents extends Record<string, unknown> {
  readonly ready: { readonly tier: DeviceTier; readonly profile: QualityProfile; readonly mode: string };
  readonly 'view-error': { readonly viewId: string; readonly message: string };
  readonly fixed: { readonly dt: number };
  readonly degrade: { readonly from: QualityProfile; readonly to: QualityProfile; readonly reason: string };
  readonly budget: { readonly cpuMs: number; readonly budgetMs: number; readonly overFrames: number };
  readonly resize: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly frame: FrameStats;
  readonly disposed: { readonly at: number };
}

export interface EngineDiagnostics {
  readonly caps: PlatformCapabilities;
  readonly decision: TierDecision;
  readonly profile: QualityProfile;
  readonly issues: readonly DiagnosticIssue[];
  readonly report: string;
  readonly fluid: FluidHostStats;
  readonly physics: PhysicsStats;
}

const now = (): number => performance.now();

/**
 * 引擎门面。
 *
 * 只做四件事：探测能力 → 定分档 → 驱动固定步长逻辑 → 把状态交给视图。
 * 不碰 Three/Pixi，不认识 DOM 布局，视图通过 ViewAdapter 插件注入。
 */
export class Engine {
  readonly caps: PlatformCapabilities;
  readonly decision: TierDecision;
  readonly tier: DeviceTier;
  readonly world: PhysicsWorld;
  readonly host: FluidHost;
  readonly loop: GameLoop;
  readonly profiler = new Profiler();
  readonly bus = new EventBus<EngineEvents>();
  readonly issues: readonly DiagnosticIssue[];
  readonly bounds: PhysicsBounds;

  private readonly views: ViewAdapter[];
  private readonly failedViews = new Set<string>();
  private readonly viewErrors: { readonly viewId: string; readonly message: string }[] = [];
  private readonly governor = new AdaptiveGovernor();
  private readonly disableAdaptive: boolean;
  private currentProfile: QualityProfile;
  private started = false;
  private disposed = false;
  private activeViewId: string | null = null;
  private fixedCpuMs = 0;
  private lastStats: FrameStats;

  private constructor(options: EngineOptions) {
    this.bounds = options.bounds ?? DEFAULT_BOUNDS;
    this.caps = detectCapabilities({ probeCanvas: options.probeCanvas ?? null });
    this.decision = resolveTier(this.caps, options.forceTier ?? null);
    this.tier = this.decision.tier;
    this.currentProfile = profileFor(this.tier, this.caps);
    this.issues = diagnose(this.caps, this.decision, this.currentProfile);
    this.disableAdaptive = options.disableAdaptive === true;

    // 流体由 host 独占：主线程模式下 host 内部持有 solver，
    // 所以 PhysicsWorld 的 fluid 置 null，避免两份状态互相打架。
    this.world = new PhysicsWorld({
      bounds: this.bounds,
      fixedDt: options.fixedDt ?? 1 / this.currentProfile.physicsHz,
      seed: options.seed ?? 20261114,
      fluid: null,
      smoke: { capacity: this.currentProfile.smokeParticles },
    });

    const workerAllowed =
      !options.forceLocalPhysics && this.currentProfile.preferWorker && this.caps.moduleWorker;
    this.host = createFluidHost({
      capacity: this.currentProfile.fluidParticles,
      sharedAvailable: canUseSharedPhysics(this.caps),
      workerAllowed,
      workerFactory: options.workerFactory ?? null,
    });

    this.views = [...(options.views ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this.lastStats = {
      fps: 0,
      frameMs: 0,
      cpuMs: 0,
      fixedSteps: 0,
      droppedMs: 0,
      fluidParticles: 0,
      smokeParticles: 0,
      drawCallsHint: 0,
    };

    this.loop = new GameLoop(
      {
        fixed: (dt, info) => this.onFixed(dt, info),
        frame: (info) => this.onFrame(info),
      },
      { fixedDt: options.fixedDt ?? 1 / this.currentProfile.physicsHz, maxSubSteps: 4 },
    );

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  static async create(options: EngineOptions = {}): Promise<Engine> {
    const engine = new Engine(options);
    await engine.start();
    return engine;
  }

  get profile(): QualityProfile {
    return this.currentProfile;
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    await this.host.start({
      fluid: {
        capacity: this.currentProfile.fluidParticles,
        smoothingRadius: 1.1,
        restDensity: 6.5,
        iterations: this.tier === 'low' ? 1 : 2,
        viscosity: 0.1,
        gravity: 9.8,
        bounds: this.bounds,
        radius: 0.24,
        maxSpeed: 24,
        surfaceTension: 0.0006,
      },
      obstacles: this.world.obstacles,
      zones: [],
    });

    // 逐个挂载视图：某个视图初始化失败（老 WebGL 驱动、上下文丢失）不拖垮整个引擎，
    // 剩下的视图照常工作 —— 这是 Android 碎片化环境下最实用的韧性策略。
    for (const view of this.views) {
      try {
        await view.attach({ engine: this, caps: this.caps, profile: this.currentProfile });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failedViews.add(view.id);
        this.viewErrors.push({ viewId: view.id, message });
        console.error(`[tabby/engine] 视图 ${view.id} 初始化失败，已跳过：${message}`);
        this.bus.emit('view-error', { viewId: view.id, message });
      }
    }
    const usable = this.views.filter((view) => !this.failedViews.has(view.id));
    if (usable.length > 0) {
      this.activeViewId = usable[0]?.id ?? null;
      for (const view of this.views) view.setActive?.(view.id === this.activeViewId);
    }

    this.bus.emit('ready', { tier: this.tier, profile: this.currentProfile, mode: this.host.mode });
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  resume(): void {
    this.loop.resetClock();
    this.loop.start();
  }

  setActiveView(id: string | null): void {
    if (id !== null && this.failedViews.has(id)) return;
    this.activeViewId = id;
    for (const view of this.views) view.setActive?.(view.id === id);
  }

  get failedViewIds(): readonly string[] {
    return [...this.failedViews];
  }

  get viewFailures(): readonly { readonly viewId: string; readonly message: string }[] {
    return this.viewErrors;
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(this.caps.devicePixelRatio, this.currentProfile.maxPixelRatio);
    for (const view of this.views) view.resize(width, height, dpr);
    this.bus.emit('resize', { width, height, dpr });
  }

  /** 同步静态几何：建筑/地形既要阻挡流体，也要阻挡布娃娃。 */
  setStaticGeometry(obstacles: readonly Obstacle[], zones: readonly AbsorbZone[]): void {
    this.world.clearObstacles();
    for (const obstacle of obstacles) this.world.addObstacle(obstacle);
    this.host.setConfig(obstacles, zones);
  }

  spawnFluid(amount: number, x: number, y: number, z: number, spread = 0.4): void {
    this.host.spawn(amount, x, y, z, spread, spread * 0.4, spread);
  }

  get fluidPositions(): Float32Array | null {
    return this.host.positions();
  }

  get fluidCount(): number {
    return this.host.count();
  }

  get zoneCounts(): readonly number[] {
    return this.host.zoneCounts();
  }

  get stats(): FrameStats {
    return this.lastStats;
  }

  getDiagnostics(): EngineDiagnostics {
    return {
      caps: this.caps,
      decision: this.decision,
      profile: this.currentProfile,
      issues: this.issues,
      report: formatCapabilityReport(this.caps, this.decision, this.currentProfile, this.issues),
      fluid: this.host.stats(),
      physics: this.world.getStats(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    for (const view of this.views) view.dispose();
    this.host.dispose();
    this.bus.emit('disposed', { at: now() });
    this.bus.clear();
  }

  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.loop.setPaused(true);
    } else {
      this.loop.setPaused(false);
      this.loop.resetClock();
    }
  };

  private onFixed(dt: number, info: FrameInfo): void {
    const t0 = now();
    this.world.step(dt);
    this.host.step(dt);
    this.fixedCpuMs += now() - t0;
    this.bus.emit('fixed', { dt });
    void info;
  }

  private onFrame(info: FrameInfo): void {
    const t0 = now();
    for (const view of this.views) {
      if (this.failedViews.has(view.id)) continue;
      if (this.activeViewId !== null && view.id !== this.activeViewId) continue;
      view.render({
        frame: info,
        alpha: info.alpha,
        deltaMs: info.deltaMs,
        profile: this.currentProfile,
      });
    }
    const cpuMs = this.fixedCpuMs + (now() - t0);
    this.fixedCpuMs = 0;
    this.profiler.record(info.deltaMs, cpuMs);
    this.profiler.markCpu(cpuMs);

    this.lastStats = {
      fps: this.profiler.fps,
      frameMs: info.deltaMs,
      cpuMs,
      fixedSteps: info.fixedSteps,
      droppedMs: info.droppedMs,
      fluidParticles: this.host.count(),
      smokeParticles: this.world.smoke.count,
      drawCallsHint: this.estimateDrawCalls(),
    };
    this.bus.emit('frame', this.lastStats);

    if (!this.disableAdaptive) this.evaluateBudget(cpuMs);
  }

  private evaluateBudget(cpuMs: number): void {
    const next = this.governor.sample(cpuMs, this.currentProfile);
    if (next === null) {
      if (cpuMs > this.currentProfile.cpuBudgetMs) {
        this.bus.emit('budget', {
          cpuMs,
          budgetMs: this.currentProfile.cpuBudgetMs,
          overFrames: 1,
        });
      }
      return;
    }
    const from = this.currentProfile;
    this.currentProfile = next;
    for (const view of this.views) view.applyProfile?.(next);
    this.bus.emit('degrade', {
      from,
      to: next,
      reason: levelReason(this.governor.currentLevel),
    });
  }

  private estimateDrawCalls(): number {
    // 只做量级估算：流体/烟雾各 1 个批次 + 每个视图的基础开销
    let calls = this.views.length * 6;
    if (this.host.count() > 0) calls += 1;
    if (this.world.smoke.count > 0) calls += 1;
    return calls;
  }
}
