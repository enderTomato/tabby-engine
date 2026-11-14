import type { ViewAdapter, ViewContext, ViewFrame, Engine } from '@tabby/engine';
import { SMOKE_STRIDE } from '@tabby/physics';
import type { QualityProfile } from '@tabby/platform';
import * as THREE from 'three';
import { BuildingLodLayer } from './building-lod.js';
import { ContextGuard } from './context-guard.js';
import { DynamicResolution } from './drs.js';
import { OrbitController } from './orbit.js';
import { PointsLayer } from './points-layer.js';
import { planShadows, type ShadowPlan } from './shadow-budget.js';

export interface Box3DSpec {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly color: number;
}

export interface SpinnerSpec {
  readonly id: string;
  /** 绑定到引擎里的某个单摆，用它的角度驱动旋转。 */
  readonly pendulumId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly thickness: number;
  readonly color: number;
}

export interface Renderer3DViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly background?: number;
  /**
   * 是否让视图自己绑拖拽/滚轮事件。默认 true。
   *
   * 用 `@tabby/input` 的 `InputManager` 统一处理输入时必须传 false：
   * 两套都绑会让同一只手势被处理两遍。
   */
  readonly manageInput?: boolean;
  /**
   * KTX2 / DRACO 解码器的托管路径，默认 `./decoders/`（相对页面）。
   *
   * 为什么放在选项里而不是写死：解码器是**部署方托管**的静态文件，
   * 引擎包无权决定人家把 CDN 挂在哪。写死相对路径的结果是——应用把解码器
   * 放在 `/static/dec/` 或者另一个域名上，就只能眼睁睁看着 404，
   * 而且报错发生在 `loadBuildingTexture()` 里，看上去像「纹理加载失败」。
   */
  readonly decoderPaths?: { readonly basis: string; readonly draco: string };
}

/** 解码器默认托管位置：与 `tools/copy-decoders.mjs` 的输出目录对齐。 */
const DEFAULT_DECODER_PATHS = { basis: './decoders/', draco: './decoders/' } as const;

const MAX_RAGDOLL_VERTS = 6 * 40 * 2;
/** 关节点上限：36 个布娃娃 × 9 点，够用且固定分配。 */
const MAX_JOINTS = 96;
const EMPTY_F32 = new Float32Array(0);

// 渲染热路径上不允许每帧新建闭包：常量回调提到模块级，只创建一次。
const FLUID_SIZE = (): number => 0.42;
const FLUID_ALPHA = (): number => 0.85;
const JOINT_SIZE = (): number => 0.22;
const JOINT_ALPHA = (): number => 0.9;

/**
 * 3D 视图（Three.js）。
 *
 * 与 2D 视图共享同一份物理状态：流体位置、烟雾粒子、布娃娃点位都来自
 * `engine` 暴露的 TypedArray，渲染层只读不改，物理包完全不知道 Three 的存在。
 */
export class Renderer3DView implements ViewAdapter {
  readonly id = 'render3d';
  readonly order = -10;

  private readonly canvas: HTMLCanvasElement;
  private readonly background: number;
  private readonly options: Renderer3DViewOptions;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private orbit: OrbitController | null = null;
  private engine: Engine | null = null;
  private profile: QualityProfile | null = null;
  private fluid: PointsLayer | null = null;
  private smoke: PointsLayer | null = null;
  private ragdollLines: THREE.LineSegments | null = null;
  private ragdollJoints: PointsLayer | null = null;
  private ragdollBuffer: Float32Array = new Float32Array(MAX_RAGDOLL_VERTS * 3);
  private boxes: THREE.InstancedMesh | null = null;
  private readonly spinners = new Map<string, { group: THREE.Group; pendulumId: string }>();
  private keyLight: THREE.DirectionalLight | null = null;
  private farLight: THREE.DirectionalLight | null = null;
  /** 建筑 LOD：近景实例化方盒 + 远景 billboard。 */
  private buildings: BuildingLodLayer | null = null;
  /** 动态分辨率。档位给的 `renderScale` 是上限，DRS 在上限内浮动。 */
  private readonly drs: DynamicResolution = new DynamicResolution();
  private guard: ContextGuard | null = null;
  private shadows: ShadowPlan = { enabled: false, near: null, far: null, reason: '尚未初始化' };
  /** 最近一帧的时间戳，DRS 用它算帧间隔。 */
  private lastFrameAt = 0;
  private dpr = 1;
  private assetHost: import('@tabby/assets').ThreeAssetHost | null = null;
  private textureError: string | null = null;
  private cssWidth = 1;
  private cssHeight = 1;
  private active = true;
  private readonly ragdollScratch = new Float32Array(512);
  /** 关节点插值的临时缓冲，避免每帧 new。 */
  private readonly ragdollPointScratch = new Float32Array(128);
  /** 关节点位置缓冲，跨帧复用，避免每帧分配触发 GC。 */
  private readonly jointBuffer = new Float32Array(MAX_JOINTS * 3);
  /** 当前帧的烟雾数据引用，供下方两个常量回调读取。 */
  private smokeData: Float32Array = EMPTY_F32;
  private readonly smokeSizeOf = (index: number): number =>
    (this.smokeData[index * SMOKE_STRIDE + 3] ?? 0.4) * 2.2;
  private readonly smokeAlphaOf = (index: number): number =>
    Math.max(0, 1 - (this.smokeData[index * SMOKE_STRIDE + 4] ?? 0)) * 0.8;
  private static readonly EMPTY = new Float32Array(0);

  constructor(options: Renderer3DViewOptions) {
    this.canvas = options.canvas;
    this.background = options.background ?? 0x070b14;
    this.options = options;
  }

  async attach(context: ViewContext): Promise<void> {
    this.engine = context.engine;
    this.profile = context.profile;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: context.profile.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    renderer.setClearColor(this.background, 1);
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    // DRS 的目标帧时间跟档位一致：低端机本来就跑 30fps，
    // 用 16.7ms 当目标会让它一直判「太慢」然后降到底
    this.drs.reset(1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(this.background, 40, 80);
    this.scene = scene;

    const maxDistance = 60;
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, maxDistance + 40);
    this.camera = camera;

    const ambient = new THREE.AmbientLight(0x8fa8c8, 1.4);
    scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    keyLight.position.set(12, 22, 10);
    scene.add(keyLight);
    this.keyLight = keyLight;
    // 阴影的具体参数不在 build 期写死，交给 applyShadows 按档位 + DRS 决定
    this.applyShadows(planShadows(context.profile, 1));

    const grid = new THREE.GridHelper(32, 16, 0x1d3557, 0x122238);
    scene.add(grid);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(32, 32),
      new THREE.MeshStandardMaterial({ color: 0x0d1726, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    scene.add(ground);

    this.fluid = new PointsLayer({
      capacity: context.profile.fluidParticles,
      color: 0x53c7ff,
      sizeScale: this.computeSizeScale(),
      opacity: 0.85,
    });
    scene.add(this.fluid.object);

    this.smoke = new PointsLayer({
      capacity: context.profile.smokeParticles,
      color: 0xc6d2e4,
      sizeScale: this.computeSizeScale(),
      opacity: 0.55,
    });
    scene.add(this.smoke.object);

    const lineGeometry = new THREE.BufferGeometry();
    const lineAttr = new THREE.BufferAttribute(this.ragdollBuffer, 3);
    lineAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeometry.setAttribute('position', lineAttr);
    lineGeometry.setDrawRange(0, 0);
    const lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: 0xffb347, linewidth: 2 }),
    );
    lines.frustumCulled = false;
    scene.add(lines);
    this.ragdollLines = lines;

    this.ragdollJoints = new PointsLayer({
      capacity: 96,
      color: 0xffd27f,
      sizeScale: this.computeSizeScale(),
      opacity: 0.95,
    });
    scene.add(this.ragdollJoints.object);

    this.buildings = new BuildingLodLayer({ enterNear: 26, exitNear: 30, maxDistance: 110 });
    scene.add(this.buildings.object);

    this.orbit = new OrbitController(this.canvas, { manageInput: this.options.manageInput });

    // 上下文丢失：冻结视图并等恢复。这里只做「不画」，
    // 模拟的暂停由引擎侧订阅同一个事件（见 docs/ANDROID-DEPLOY.md）。
    this.guard = new ContextGuard(this.canvas, {
      onLost: () => {
        this.lastFrameAt = 0;
      },
      onRestored: () => {
        // 恢复后分辨率与样本都重新来过：之前的帧时间属于旧上下文，没有参考价值
        this.drs.reset(this.drs.scale);
        this.applyResolution();
        this.lastFrameAt = 0;
      },
    });

    this.resize(this.cssWidth, this.cssHeight, context.caps.devicePixelRatio);
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.dpr = dpr;
    this.applyResolution();
  }

  /**
   * 真的把分辨率推到 GPU 上。
   *
   * ## 为什么不用 `setPixelRatio` + `setSize(css × scale)`
   *
   * 那条路上「最终 drawing buffer 多大」要读者自己在脑子里乘三次
   * （DPR × renderScale × pixelRatio），改一个参数就得重新推。
   * 这里直接把目标缓冲尺寸算出来，`pixelRatio` 固定为 1，只有一处乘法。
   *
   * 顺带解决一个一直存在的小问题：点精灵的 `gl_PointSize` 是**设备像素**，
   * 而之前的 `sizeScale` 只按 CSS 高度算，于是同一份场景在 DPR=3 的手机上
   * 粒子看起来比桌面小三倍。现在按真实缓冲高度算，跨设备一致。
   */
  private applyResolution(): void {
    const renderer = this.renderer;
    const profile = this.profile;
    const camera = this.camera;
    if (renderer === null || profile === null || camera === null) return;

    const ratio = Math.min(this.dpr, profile.maxPixelRatio) * profile.renderScale * this.drs.scale;
    const bufferWidth = Math.max(1, Math.round(this.cssWidth * ratio));
    const bufferHeight = Math.max(1, Math.round(this.cssHeight * ratio));

    renderer.setPixelRatio(1);
    renderer.setSize(bufferWidth, bufferHeight, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    camera.aspect = this.cssWidth / this.cssHeight;
    camera.updateProjectionMatrix();

    const sizeScale = this.computeSizeScale(bufferHeight);
    this.fluid?.setSizeScale(sizeScale);
    this.smoke?.setSizeScale(sizeScale);
    this.ragdollJoints?.setSizeScale(sizeScale);

    // 分辨率一降，阴影也该跟着让路 —— 这里不做实时联动，等到下一次 DRS 调整时统一过一遍
    const next = planShadows(profile, this.drs.scale);
    if (next.near?.mapSize !== this.shadows.near?.mapSize || next.far?.mapSize !== this.shadows.far?.mapSize || next.enabled !== this.shadows.enabled) {
      this.applyShadows(next);
    }
  }

  /**
   * 轨道相机。集成 `@tabby/input` 时把 `InputManager` 的手势喂给
   * `orbitController.orbitDriver`，并确保视图不再自己绑事件（`manageInput: false`）。
   */
  get orbitController(): OrbitController | null {
    return this.orbit;
  }

  /**
   * 当前相机矩阵，供 `RenderBridge` 做世界→屏幕投影。
   *
   * 返回值里的数组是 **three 的内部缓冲区**（每帧被覆写），需要保留请自己 copy。
   * 这么做是为了让这条路径零分配：投影每帧都要算一次，复制 32 个 float 也是分配。
   */
  get cameraMatrices(): {
    readonly projection: Float32Array;
    readonly view: Float32Array;
    readonly eye: { readonly x: number; readonly y: number; readonly z: number };
  } | null {
    const camera = this.camera;
    if (camera === null) return null;
    camera.updateMatrixWorld();
    return {
      projection: camera.projectionMatrix.elements as unknown as Float32Array,
      view: camera.matrixWorldInverse.elements as unknown as Float32Array,
      eye: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    };
  }

  render(frame: ViewFrame): void {
    if (!this.active) return;
    const { renderer, scene, camera, engine } = this;
    if (renderer === null || scene === null || camera === null || engine === null) return;
    // 上下文丢了就别再往 GL 上写：这时候所有调用都是空转，还会刷一屏 INVALID_OPERATION
    if (this.guard?.isLost === true) return;

    const now = performance.now();
    // 惯性要用真实时间差，不能用固定步长（见 OrbitController.update 注释）
    this.orbit?.update(now);
    this.updateFluid(engine);
    this.updateSmoke(engine);
    this.updateRagdolls(engine, frame.alpha);
    this.updateSpinners(engine);
    this.orbit?.apply(camera);

    // LOD 按相机位置更新。放在 render 之前、相机矩阵算好之后 ——
    // 用上一帧的相机位置做分类会让快速转动时远近切换慢一帧，肉眼能看出来。
    this.buildings?.update(camera.position.x, camera.position.z);

    renderer.render(scene, camera);

    if (this.lastFrameAt > 0 && this.drs.push(now - this.lastFrameAt, now)) {
      this.applyResolution();
    }
    this.lastFrameAt = now;
  }

  applyProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.applyShadows(planShadows(profile, this.drs.scale));
    this.applyResolution();
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  /**
   * 同步建筑实例（整批重建，但只在建筑变化时调用）。
   *
   * 实际绘制交给 `BuildingLodLayer`：近处是实例化方盒，远处是 billboard 贴片。
   * 这里保留 `boxes` 字段只为兼容老的 `debugInfo` 读取。
   */
  setBoxes(specs: readonly Box3DSpec[]): void {
    const scene = this.scene;
    if (scene === null) return;
    if (this.buildings === null) {
      this.buildings = new BuildingLodLayer();
      scene.add(this.buildings.object);
    }
    this.buildings.setBuildings(specs);
    this.buildings.setShadows(this.shadows.enabled);
    // 建筑刚换过，相机没动也要重新分类一次
    const camera = this.camera;
    if (camera !== null) this.buildings.update(camera.position.x, camera.position.z, true);
    this.boxes = null;
  }

  /**
   * 接入压缩纹理（KTX2）。
   *
   * 走 `@tabby/assets` 的候选链：能力允许就加载 `.ktx2`，否则退回未压缩版。
   * 加载器与解码器都是**动态 import** 的，所以「只想画几个方块」的游戏不会
   * 因为调了这个 API 就多下 900KB。
   *
   * 贴图同时应用到建筑方盒与远景贴片：没有它，远处建筑就是一排纯色片。
   */
  async loadBuildingTexture(base: string, legacy: readonly string[] = ['png']): Promise<boolean> {
    const renderer = this.renderer;
    if (renderer === null) return false;
    try {
      const { ThreeAssetHost, probeAssetCapabilities } = await import('@tabby/assets');
      const gl = renderer.getContext();
      const caps = probeAssetCapabilities(gl as WebGL2RenderingContext, renderer.capabilities.isWebGL2);
      if (this.assetHost === null) {
        this.assetHost = new ThreeAssetHost({
          renderer,
          decoderPaths: this.options.decoderPaths ?? DEFAULT_DECODER_PATHS,
          caps,
        });
      }
      const texture = await this.assetHost.loadTexture(base, legacy);
      const material = this.boxes?.material as THREE.MeshStandardMaterial | undefined;
      if (material !== undefined) {
        material.map = texture;
        material.needsUpdate = true;
      }
      this.buildings?.setImpostorTexture(texture);
      return true;
    } catch (error) {
      // 纹理是锦上添花：加载失败继续用纯色，不该把整个场景拖黑
      this.textureError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** 画质与稳定性诊断：面板直接用，省得再去翻各个子系统。 */
  get qualityInfo(): {
    readonly drsScale: number;
    readonly medianFrameMs: number;
    readonly adjustments: number;
    readonly shadowReason: string;
    readonly shadowMaps: number;
    readonly lodNear: number;
    readonly lodFar: number;
    readonly lodCulled: number;
    readonly contextLost: number;
    readonly contextRestored: number;
    readonly bufferWidth: number;
    readonly bufferHeight: number;
    readonly textureError: string | null;
  } {
    const split = this.buildings?.lodSplit ?? { near: 0, far: 0, culled: 0 };
    const drs = this.drs.state;
    return {
      drsScale: drs.scale,
      medianFrameMs: drs.medianFrameMs,
      adjustments: drs.adjustments,
      shadowReason: this.shadows.reason,
      shadowMaps: (this.shadows.near === null ? 0 : 1) + (this.shadows.far === null ? 0 : 1),
      lodNear: split.near,
      lodFar: split.far,
      lodCulled: split.culled,
      contextLost: this.guard?.stats.lost ?? 0,
      contextRestored: this.guard?.stats.restored ?? 0,
      bufferWidth: this.renderer?.getContext().drawingBufferWidth ?? 0,
      bufferHeight: this.renderer?.getContext().drawingBufferHeight ?? 0,
      textureError: this.textureError,
    };
  }

  /** 手动把分辨率打回满档（切场景、改画质设置后调用）。 */
  resetDynamicResolution(): void {
    this.drs.reset(1);
    this.applyResolution();
  }

  /** 绑定风车/水车：几何体绕 Z 轴旋转，角度来自物理层单摆。 */
  bindSpinners(specs: readonly SpinnerSpec[]): void {
    const scene = this.scene;
    if (scene === null) return;
    for (const [id, entry] of this.spinners) {
      scene.remove(entry.group);
      entry.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.spinners.delete(id);
    }
    for (const spec of specs) {
      const group = new THREE.Group();
      group.position.set(spec.x, spec.y, spec.z);
      const bladeGeometry = new THREE.BoxGeometry(spec.radius, spec.thickness, spec.thickness);
      const bladeMaterial = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.6 });
      for (let i = 0; i < 4; i += 1) {
        const blade = new THREE.Mesh(bladeGeometry, bladeMaterial);
        blade.rotation.z = (Math.PI / 2) * i;
        blade.castShadow = true;
        group.add(blade);
      }
      scene.add(group);
      this.spinners.set(spec.id, { group, pendulumId: spec.pendulumId });
    }
  }

  get drawCalls(): number {
    return this.renderer?.info.render.calls ?? 0;
  }

  /** 调试用：当前绘制规模，测试用例与线上排障都会读它。 */
  get debugInfo(): {
    readonly fluidPoints: number;
    readonly smokePoints: number;
    readonly ragdollVerts: number;
    readonly drawCalls: number;
    readonly triangles: number;
  } {
    const drawRange = this.ragdollLines?.geometry.drawRange;
    return {
      fluidPoints: this.fluid?.count ?? 0,
      smokePoints: this.smoke?.count ?? 0,
      ragdollVerts: drawRange === undefined || drawRange.count === Infinity ? 0 : drawRange.count,
      drawCalls: this.renderer?.info.render.calls ?? 0,
      triangles: this.renderer?.info.render.triangles ?? 0,
    };
  }

  dispose(): void {
    this.guard?.dispose();
    this.guard = null;
    this.assetHost?.dispose();
    this.assetHost = null;
    this.buildings?.dispose();
    this.buildings = null;
    this.orbit?.dispose();
    this.orbit = null;
    this.fluid?.dispose();
    this.smoke?.dispose();
    this.ragdollJoints?.dispose();
    this.fluid = null;
    this.smoke = null;
    this.ragdollJoints = null;
    if (this.ragdollLines !== null) {
      this.ragdollLines.geometry.dispose();
      (this.ragdollLines.material as THREE.Material).dispose();
      this.ragdollLines = null;
    }
    if (this.boxes !== null) {
      this.boxes.geometry.dispose();
      (this.boxes.material as THREE.Material).dispose();
      this.boxes = null;
    }
    for (const entry of this.spinners.values()) {
      entry.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    }
    this.spinners.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.engine = null;
  }

  private computeSizeScale(bufferHeight = this.cssHeight): number {
    const fovRad = ((this.camera?.fov ?? 50) * Math.PI) / 180;
    // 用**真实 drawing buffer 高度**：gl_PointSize 是设备像素，
    // 按 CSS 高度算会让同场景在高 DPR 设备上粒子偏小
    return bufferHeight / (2 * Math.tan(fovRad / 2));
  }

  /**
   * 应用阴影预算。
   *
   * 「两级」不是 CSM 的级联：这里是**两盏独立平行光**，近处那盏覆盖 18m
   * 用高分辨率图，远处那盏覆盖 60m 用低分辨率图。没有级联拼接，
   * 也就没有接缝，代价只是多一次 shadow pass —— 而且只在高端档才开。
   */
  private applyShadows(plan: ShadowPlan): void {
    this.shadows = plan;
    const renderer = this.renderer;
    const scene = this.scene;
    if (renderer === null || scene === null) return;

    renderer.shadowMap.enabled = plan.enabled;

    const near = this.keyLight;
    if (near !== null) {
      near.castShadow = plan.enabled;
      const stage = plan.near;
      if (stage !== null) {
        near.shadow.mapSize.set(stage.mapSize, stage.mapSize);
        near.shadow.camera.left = -stage.extent;
        near.shadow.camera.right = stage.extent;
        near.shadow.camera.top = stage.extent;
        near.shadow.camera.bottom = -stage.extent;
        near.shadow.camera.near = stage.near;
        near.shadow.camera.far = stage.far;
        near.shadow.camera.updateProjectionMatrix();
        // 换过 mapSize 必须丢掉旧的 render target，否则 three 会继续用旧尺寸
        near.shadow.map?.dispose();
        near.shadow.map = null;
      }
    }

    const far = plan.far;
    if (far === null) {
      if (this.farLight !== null) {
        scene.remove(this.farLight);
        this.farLight.shadow.map?.dispose();
        this.farLight.dispose();
        this.farLight = null;
      }
    } else {
      if (this.farLight === null) {
        const light = new THREE.DirectionalLight(0xffffff, 0.9);
        light.position.set(-14, 26, -18);
        scene.add(light);
        this.farLight = light;
      }
      const light = this.farLight;
      light.castShadow = true;
      light.shadow.mapSize.set(far.mapSize, far.mapSize);
      light.shadow.camera.left = -far.extent;
      light.shadow.camera.right = far.extent;
      light.shadow.camera.top = far.extent;
      light.shadow.camera.bottom = -far.extent;
      light.shadow.camera.near = far.near;
      light.shadow.camera.far = far.far;
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }

    this.buildings?.setShadows(plan.enabled);
  }

  private updateFluid(engine: Engine): void {
    const layer = this.fluid;
    if (layer === null) return;
    const positions = engine.fluidPositions;
    if (positions === null) {
      layer.update(Renderer3DView.EMPTY, 0, 3);
      return;
    }
    layer.update(positions, engine.fluidCount, 3, FLUID_SIZE, FLUID_ALPHA);
  }

  private updateSmoke(engine: Engine): void {
    const layer = this.smoke;
    if (layer === null) return;
    const smoke = engine.world.smoke;
    this.smokeData = smoke.renderData;
    layer.update(smoke.renderData, smoke.count, SMOKE_STRIDE, this.smokeSizeOf, this.smokeAlphaOf);
  }

  /**
   * `alpha` 来自主循环的固定步长余量。
   *
   * 物理跑 30Hz、屏幕 60Hz 时，同一个物理状态会被渲染两帧；
   * 不插值就是每两帧跳一下（「果冻感」）。lerp(上一步, 当前步, alpha) 把它抹平，
   * 代价是显示比物理状态滞后不到一帧 —— 对点线骨架完全无感。
   */
  private updateRagdolls(engine: Engine, alpha: number): void {
    const lines = this.ragdollLines;
    if (lines === null) return;
    const ragdolls = engine.world.getRagdollOrder();
    const out = this.ragdollBuffer;
    const maxFloats = out.length;
    const scratch = this.ragdollScratch;
    let write = 0;
    for (const ragdoll of ragdolls) {
      const bones = ragdoll.boneCount;
      if (bones * 6 > scratch.length) continue;
      ragdoll.writeInterpolatedSegments(scratch, alpha);
      const floats = bones * 6;
      if (write + floats > maxFloats) break;
      out.set(scratch.subarray(0, floats), write);
      write += floats;
    }
    const attr = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    lines.geometry.setDrawRange(0, write / 3);

    // 关节点：布娃娃贴地后只剩二维骨架，用点把关节"点"出来更好读
    const joints = this.ragdollJoints;
    if (joints !== null) {
      const jointPositions = this.jointBuffer;
      let count = 0;
      const pointScratch = this.ragdollPointScratch;
      for (const ragdoll of ragdolls) {
        if (ragdoll.pointCount * 3 > pointScratch.length) continue;
        ragdoll.writePointPositions(pointScratch, alpha);
        for (let i = 0; i < ragdoll.pointCount && count < MAX_JOINTS; i += 1) {
          jointPositions[count * 3] = pointScratch[i * 3] ?? 0;
          jointPositions[count * 3 + 1] = pointScratch[i * 3 + 1] ?? 0;
          jointPositions[count * 3 + 2] = pointScratch[i * 3 + 2] ?? 0;
          count += 1;
        }
      }
      joints.update(jointPositions, count, 3, JOINT_SIZE, JOINT_ALPHA);
    }
  }

  private updateSpinners(engine: Engine): void {
    for (const entry of this.spinners.values()) {
      const pendulum = engine.world.getPendulum(entry.pendulumId);
      if (pendulum === null) continue;
      entry.group.rotation.z = -pendulum.angle;
    }
  }
}
