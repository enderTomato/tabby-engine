import type { ViewAdapter, ViewContext, ViewFrame, Engine } from '@tabby/engine';
import { SMOKE_STRIDE } from '@tabby/physics';
import type { QualityProfile } from '@tabby/platform';
import * as THREE from 'three';
import { OrbitController } from './orbit.js';
import { PointsLayer } from './points-layer.js';

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
}

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
  private cssWidth = 1;
  private cssHeight = 1;
  private active = true;
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
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
    renderer.shadowMap.enabled = context.profile.shadowQuality !== 'off';
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

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
    if (context.profile.shadowQuality !== 'off') {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(
        context.profile.shadowQuality === 'high' ? 1024 : 512,
        context.profile.shadowQuality === 'high' ? 1024 : 512,
      );
      keyLight.shadow.camera.left = -20;
      keyLight.shadow.camera.right = 20;
      keyLight.shadow.camera.top = 20;
      keyLight.shadow.camera.bottom = -20;
    }
    scene.add(keyLight);
    this.keyLight = keyLight;

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

    this.orbit = new OrbitController(this.canvas, { manageInput: this.options.manageInput });
    this.resize(this.cssWidth, this.cssHeight, context.caps.devicePixelRatio);
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    if (this.renderer === null || this.camera === null || this.profile === null) return;
    const scale = this.profile.renderScale;
    const resolution = Math.min(dpr, this.profile.maxPixelRatio);
    this.renderer.setPixelRatio(resolution);
    this.renderer.setSize(this.cssWidth * scale, this.cssHeight * scale, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = this.cssWidth / this.cssHeight;
    this.camera.updateProjectionMatrix();
    const sizeScale = this.computeSizeScale() / scale;
    this.fluid?.setSizeScale(sizeScale);
    this.smoke?.setSizeScale(sizeScale);
    this.ragdollJoints?.setSizeScale(sizeScale);
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

    // 惯性要用真实时间差，不能用固定步长（见 OrbitController.update 注释）
    this.orbit?.update(performance.now());
    this.updateFluid(engine);
    this.updateSmoke(engine);
    this.updateRagdolls(engine, frame.alpha);
    this.updateSpinners(engine);
    this.orbit?.apply(camera);
    renderer.render(scene, camera);
  }

  applyProfile(profile: QualityProfile): void {
    this.profile = profile;
    if (this.renderer !== null) {
      this.renderer.shadowMap.enabled = profile.shadowQuality !== 'off';
      if (this.keyLight !== null) this.keyLight.castShadow = profile.shadowQuality !== 'off';
    }
    this.resize(this.cssWidth, this.cssHeight, profile.maxPixelRatio);
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  /** 同步建筑实例（整批重建，但只在建筑变化时调用）。 */
  setBoxes(specs: readonly Box3DSpec[]): void {
    const scene = this.scene;
    if (scene === null) return;
    if (this.boxes !== null) {
      scene.remove(this.boxes);
      this.boxes.geometry.dispose();
      (this.boxes.material as THREE.Material).dispose();
      this.boxes = null;
    }
    if (specs.length === 0) return;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    specs.forEach((spec, index) => {
      this.matrix.makeScale(spec.width, spec.height, spec.depth);
      this.matrix.setPosition(spec.x + spec.width / 2, spec.y, spec.z + spec.depth / 2);
      mesh.setMatrixAt(index, this.matrix);
      mesh.setColorAt(index, this.color.setHex(spec.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    this.boxes = mesh;
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

  private computeSizeScale(): number {
    const height = this.cssHeight * (this.profile?.renderScale ?? 1);
    const fovRad = ((this.camera?.fov ?? 50) * Math.PI) / 180;
    return height / (2 * Math.tan(fovRad / 2));
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
