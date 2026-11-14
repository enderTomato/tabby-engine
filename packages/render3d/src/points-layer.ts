import * as THREE from 'three';

export interface PointsLayerOptions {
  readonly capacity: number;
  readonly color: THREE.ColorRepresentation;
  /** gl_PointSize 的换算系数：约等于 canvas 高度 / (2 * tan(fov/2))。 */
  readonly sizeScale: number;
  readonly opacity?: number;
  readonly blending?: THREE.Blending;
  /** 是否每帧更新尺寸/透明度（静态点可关闭省带宽）。 */
  readonly dynamicSize?: boolean;
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  varying float vAlpha;
  uniform float uSizeScale;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uSizeScale / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float edge = 1.0 - smoothstep(0.08, 0.5, r);
    gl_FragColor = vec4(uColor, edge * vAlpha * uOpacity);
  }
`;

/**
 * 点精灵层（单个 DrawCall 承载全部粒子）。
 *
 * 用自定义 shader 而不是 PointsMaterial 的原因：
 * PointsMaterial 只能全点同尺寸，烟雾需要「随生命周期膨胀 + 淡出」，
 * 换成逐点 attribute 后仍然是 1 个 DrawCall，成本只多两个 float 属性。
 */
export class PointsLayer {
  readonly object: THREE.Points;
  readonly capacity: number;

  private readonly geometry: THREE.BufferGeometry;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private activeCount = 0;

  constructor(options: PointsLayerOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.capacity * 3);
    const sizes = new Float32Array(this.capacity);
    const alphas = new Float32Array(this.capacity);
    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(sizes, 1);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(alphas, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aSize', this.sizeAttr);
    this.geometry.setAttribute('aAlpha', this.alphaAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(options.color) },
        uOpacity: { value: options.opacity ?? 1 },
        uSizeScale: { value: options.sizeScale },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: options.blending ?? THREE.NormalBlending,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
  }

  /** 从交错缓冲拷贝 n 个粒子（stride 为交错步长）。 */
  update(source: Float32Array, count: number, stride: number, sizeOf?: (index: number) => number, alphaOf?: (index: number) => number): void {
    const n = Math.min(count, this.capacity);
    const positions = this.positionAttr.array as Float32Array;
    const sizes = this.sizeAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;

    if (stride === 3) {
      positions.set(source.subarray(0, n * 3));
    } else {
      for (let i = 0; i < n; i += 1) {
        positions[i * 3] = source[i * stride] ?? 0;
        positions[i * 3 + 1] = source[i * stride + 1] ?? 0;
        positions[i * 3 + 2] = source[i * stride + 2] ?? 0;
      }
    }

    for (let i = 0; i < n; i += 1) {
      sizes[i] = sizeOf === undefined ? 0.5 : sizeOf(i);
      alphas[i] = alphaOf === undefined ? 1 : alphaOf(i);
    }

    this.positionAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
    this.activeCount = n;
  }

  setSizeScale(scale: number): void {
    this.material.uniforms.uSizeScale = { value: scale };
  }

  get count(): number {
    return this.activeCount;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
