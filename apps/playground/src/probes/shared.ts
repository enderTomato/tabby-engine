/**
 * 探针共用的小工具。
 *
 * 只放「每个探针都要写一遍会很啰嗦」的东西：浮层面板、按钮组、
 * 以及一个最小的 Three 舞台。不是框架，就是几个函数。
 */

import * as THREE from 'three';

/** 左上角浮层。探针往里塞 `row` 就能显示实时数字。 */
export function makeOverlay(host: HTMLElement, title: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'probe-overlay';
  const head = document.createElement('div');
  head.innerHTML = `<b>${title}</b>`;
  box.appendChild(head);
  host.appendChild(box);
  return box;
}

/** 往浮层里加一行「标签 / 值」，返回值节点 —— 探针每帧只改 `textContent`。 */
export function addRow(overlay: HTMLElement, label: string): HTMLSpanElement {
  const row = document.createElement('div');
  row.className = 'row';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('span');
  value.textContent = '—';
  row.append(name, value);
  overlay.appendChild(row);
  return value;
}

/** 底部按钮组，返回容器。 */
export function makeControls(host: HTMLElement): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'probe-controls';
  host.appendChild(bar);
  return bar;
}

export function addButton(bar: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  bar.appendChild(button);
  return button;
}

export interface ThreeStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  resize(): void;
  dispose(): void;
}

/**
 * 最小 Three 舞台。
 *
 * 不用 `@tabby/render3d` 的 `Renderer3DView`：那个类带引擎生命周期、
 * 档位判定、视角控制器 —— 对单个探针来说是噪声。这里只要能画一帧。
 * 点精灵层仍然用 `PointsLayer`，那才是要验的东西。
 */
export function createThreeStage(host: HTMLElement, background = 0x06080d): ThreeStage {
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(background, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(background, 26, 62);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 220);
  camera.position.set(9, 8, 14);
  camera.lookAt(0, 4, 0);

  scene.add(new THREE.HemisphereLight(0xbfd8f0, 0x0a1018, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(6, 14, 8);
  scene.add(key);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x0d1620, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const grid = new THREE.GridHelper(120, 60, 0x1b2c3d, 0x12202c);
  scene.add(grid);

  const resize = (): void => {
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();

  const dispose = (): void => {
    scene.traverse((object) => {
      const mesh = object as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const item of material) item.dispose();
      else material?.dispose();
    });
    renderer.dispose();
    // `dispose()` 只清 three 自己那本 GPU 资源账，**上下文不会归还**。
    // 浏览器每页有个硬配额（Chromium 是 16 个），探针可以随便来回切，
    // 不还上下文切到第十几次就再也建不出来，报 "BindToCurrentSequence failed"。
    // 必须在 dispose 之后显式丢掉上下文。
    renderer.forceContextLoss();
    canvas.remove();
  };

  return { renderer, scene, camera, canvas, resize, dispose };
}

/**
 * 简易轨道相机：拖拽转、滚轮缩放、双指捏合。
 *
 * 故意不复用 `@tabby/input`：那个探针要单独验手势识别，
 * 如果这里也用它，手势探针挂了会让所有 3D 探针一起挂 —— 那就不是隔离验证了。
 */
export function attachOrbit(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera, target = new THREE.Vector3(0, 4, 0)): () => void {
  let theta = 0.62;
  let phi = 1.06;
  let distance = 20;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const apply = (): void => {
    const sinPhi = Math.sin(phi);
    camera.position.set(
      target.x + distance * sinPhi * Math.sin(theta),
      target.y + distance * Math.cos(phi),
      target.z + distance * sinPhi * Math.cos(theta),
    );
    camera.lookAt(target);
  };
  apply();

  const onDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent): void => {
    if (!dragging) return;
    theta -= (event.clientX - lastX) * 0.006;
    phi = Math.max(0.22, Math.min(1.45, phi - (event.clientY - lastY) * 0.005));
    lastX = event.clientX;
    lastY = event.clientY;
    apply();
  };
  const onUp = (event: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    distance = Math.max(6, Math.min(70, distance + event.deltaY * 0.02));
    apply();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
  };
}

/** 假的固定种子随机（探针要可复现，不能用 Math.random）。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}
