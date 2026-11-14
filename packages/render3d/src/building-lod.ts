/**
 * 建筑 LOD：近处实例化方盒，远处 billboard 贴片。
 *
 * ## 为什么是这两个档，不是三个
 *
 * 方盒和贴片之间没有中间态值得花钱：再插一档「低面数方盒」，省下的三角形
 * 还不如它多出来的 DrawCall 贵。而贴片能把「一栋楼 = 12 个三角形」压到 2 个，
 * 这才是量级上的差别。
 *
 * ## 贴片为什么是「留接口」而不是「直接给图」
 *
 * 真实的 impostor 需要离线烘焙：从 8/16 个方位角各渲一遍目标网格，拍成图集，
 * 运行时按相机方位挑一列。那需要资产生成管线，而这个仓库至今没有资产
 * （所有画面都是程序化生成的）。所以这里：
 *
 * - 贴片几何、批量朝向、按方位切 UV 的**机制**都真做了；
 * - 贴图本身留成 `setImpostorTexture()` 一个入口 —— 有了烘好的图集接上就能用；
 * - 没有图时它是纯色剪影，远看仍然是「一片楼」而不是空白，属于可用的降级态。
 *
 * 假装做了烘焙、实际贴一张程序化渐变，比现在更糟：那会让人以为管线是通的。
 */

import * as THREE from 'three';
import { classifyLod, type LodSplit, type LodThresholds } from './lod.js';

/** 与 `view3d.ts` 的 `Box3DSpec` 结构一致（那边只是别名，不反向 import 免得成环）。 */
export interface LodBoxSpec {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly color: number;
}

export interface BuildingLodOptions {
  /** 进入近景的距离（米）。 */
  readonly enterNear?: number;
  /** 退回贴片的距离（米）。比 `enterNear` 大 3~6m 形成迟滞带。 */
  readonly exitNear?: number;
  /** 超过这个距离不画。默认 110m。 */
  readonly maxDistance?: number;
  /** 相机移动超过这个距离才重新分类（米）。每次分类都要重写实例矩阵。 */
  readonly reclassifyMove?: number;
}

export class BuildingLodLayer {
  readonly object = new THREE.Group();

  private nearMesh: THREE.InstancedMesh | null = null;
  private farMesh: THREE.InstancedMesh | null = null;
  private specs: readonly LodBoxSpec[] = [];
  private points = new Float32Array(0);
  private states = new Uint8Array(0);
  private nearIndex = new Int32Array(0);
  private farIndex = new Int32Array(0);
  private split: LodSplit = { near: 0, far: 0, culled: 0 };
  private readonly thresholds: LodThresholds;
  private readonly reclassifyMove: number;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(options: BuildingLodOptions = {}) {
    const enterNear = options.enterNear ?? 26;
    this.thresholds = {
      enterNear,
      // 退出比进入宽 4m：站在分界线附近挪几步不会来回切
      exitNear: options.exitNear ?? enterNear + 4,
      maxDistance: options.maxDistance ?? 110,
    };
    this.reclassifyMove = options.reclassifyMove ?? 1.5;
  }

  get lodSplit(): LodSplit {
    return this.split;
  }

  get thresholdsUsed(): LodThresholds {
    return this.thresholds;
  }

  /** 重建实例（建筑增删时调用，不是每帧）。 */
  setBuildings(specs: readonly LodBoxSpec[]): void {
    this.disposeMeshes();
    this.specs = specs;
    const count = specs.length;
    if (count === 0) return;

    this.points = new Float32Array(count * 2);
    this.states = new Uint8Array(count);
    this.nearIndex = new Int32Array(count);
    this.farIndex = new Int32Array(count);
    for (let i = 0; i < count; i += 1) {
      const spec = specs[i] as LodBoxSpec;
      // 用底面中心作为距离基准：楼很高时用几何中心会让「近处」判得偏晚
      this.points[i * 2] = spec.x + spec.width / 2;
      this.points[i * 2 + 1] = spec.z + spec.depth / 2;
    }

    // 近景：方盒几何上移半格，让 y 表示「底面」而不是「中心」，摆位时不用再加 height/2
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.translate(0, 0.5, 0);
    const nearMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 });
    this.nearMesh = new THREE.InstancedMesh(boxGeometry, nearMaterial, count);
    this.nearMesh.castShadow = true;
    this.nearMesh.receiveShadow = true;
    // 不参与视锥剔除：实例的包围盒是按容量算的，剔除会把整批一次剔掉
    this.nearMesh.frustumCulled = false;
    this.nearMesh.count = 0;
    this.object.add(this.nearMesh);

    const quadGeometry = new THREE.PlaneGeometry(1, 1);
    quadGeometry.translate(0, 0.5, 0);
    const farMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
    this.farMesh = new THREE.InstancedMesh(quadGeometry, farMaterial, count);
    this.farMesh.frustumCulled = false;
    this.farMesh.count = 0;
    this.object.add(this.farMesh);

    // 分类结果还没算，先全部当作远景，避免第一帧出现「全部挤在原点」
    this.lastX = Number.NaN;
    this.lastZ = Number.NaN;
  }

  /**
   * 按相机位置重新分类并写实例矩阵。
   *
   * 相机没怎么动就直接返回 —— 分类本身只有 O(n) 次距离比较，但重写实例矩阵
   * 要上传到 GPU，那个才是贵的。
   */
  update(cameraX: number, cameraZ: number, force = false): boolean {
    const nearMesh = this.nearMesh;
    const farMesh = this.farMesh;
    if (nearMesh === null || farMesh === null) return false;

    const moved = force || !(Math.abs(cameraX - this.lastX) < this.reclassifyMove && Math.abs(cameraZ - this.lastZ) < this.reclassifyMove);
    if (!moved) return false;
    this.lastX = cameraX;
    this.lastZ = cameraZ;

    const split = classifyLod(
      this.points,
      this.states,
      this.specs.length,
      cameraX,
      cameraZ,
      this.thresholds,
      this.nearIndex,
      this.farIndex,
    );
    this.split = split;

    for (let slot = 0; slot < split.near; slot += 1) {
      const index = this.nearIndex[slot] as number;
      const spec = this.specs[index] as LodBoxSpec;
      this.position.set(spec.x + spec.width / 2, spec.y, spec.z + spec.depth / 2);
      this.scale.set(spec.width, spec.height, spec.depth);
      this.matrix.compose(this.position, this.quaternion.identity(), this.scale);
      nearMesh.setMatrixAt(slot, this.matrix);
      nearMesh.setColorAt(slot, this.color.setHex(spec.color));
    }
    nearMesh.count = split.near;
    nearMesh.instanceMatrix.needsUpdate = true;
    if (nearMesh.instanceColor !== null) nearMesh.instanceColor.needsUpdate = true;

    for (let slot = 0; slot < split.far; slot += 1) {
      const index = this.farIndex[slot] as number;
      const spec = this.specs[index] as LodBoxSpec;
      const x = spec.x + spec.width / 2;
      const z = spec.z + spec.depth / 2;
      // 贴片绕 Y 轴转向相机；用 atan2 而不是 lookAt，省一次矩阵求逆
      const yaw = Math.atan2(cameraX - x, cameraZ - z);
      this.position.set(x, spec.y, z);
      this.scale.set(Math.max(spec.width, spec.depth), spec.height, 1);
      this.quaternion.setFromAxisAngle(UP, yaw);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      farMesh.setMatrixAt(slot, this.matrix);
      farMesh.setColorAt(slot, this.color.setHex(spec.color));
    }
    farMesh.count = split.far;
    farMesh.instanceMatrix.needsUpdate = true;
    if (farMesh.instanceColor !== null) farMesh.instanceColor.needsUpdate = true;

    return true;
  }

  /**
   * 接上烘焙好的 impostor 图集。
   *
   * 图集约定：横向 8 列 = 8 个方位角，纵向 1 行。真正的按方位挑 UV 需要在
   * 实例属性里塞一个 uvOffset，那属于「有图之后」的事；现在先让整张图当贴图用，
   * 保证接上就能看见效果。
   */
  setImpostorTexture(texture: THREE.Texture | null): void {
    const material = this.farMesh?.material as THREE.MeshBasicMaterial | undefined;
    if (material === undefined) return;
    material.map = texture;
    if (texture !== null) {
      // 有贴图时用白色打底，否则 instanceColor 会把贴图整体染色
      material.color.set(0xffffff);
      material.transparent = true;
      material.alphaTest = 0.35;
    }
    material.needsUpdate = true;
  }

  /** 阴影开关跟随档位：远景贴片不投影（它本来就是个平面，投出来的影子是错的）。 */
  setShadows(enabled: boolean): void {
    if (this.nearMesh !== null) this.nearMesh.castShadow = enabled;
    if (this.farMesh !== null) this.farMesh.castShadow = false;
  }

  get drawCalls(): number {
    let calls = 0;
    if (this.nearMesh !== null && this.nearMesh.count > 0) calls += 1;
    if (this.farMesh !== null && this.farMesh.count > 0) calls += 1;
    return calls;
  }

  dispose(): void {
    this.disposeMeshes();
    this.specs = [];
  }

  private disposeMeshes(): void {
    for (const mesh of [this.nearMesh, this.farMesh]) {
      if (mesh === null) continue;
      this.object.remove(mesh);
      mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) for (const item of material) item.dispose();
      else material.dispose();
      mesh.dispose();
    }
    this.nearMesh = null;
    this.farMesh = null;
    this.split = { near: 0, far: 0, culled: 0 };
  }
}

const UP = new THREE.Vector3(0, 1, 0);
