import type { PhysicsBounds } from '@tabby/physics';
import type { QualityProfile } from '@tabby/platform';
import type { Engine, ViewAdapter, ViewContext, ViewFrame } from '@tabby/engine';
import { SMOKE_STRIDE } from '@tabby/physics';
import { Application, Container, Graphics, Particle, ParticleContainer, Texture } from 'pixi.js';
import { createRadialTexture } from './textures.js';

export interface Renderer2DTheme {
  readonly background: number;
  readonly grid: number;
  readonly fluid: number;
  readonly smoke: number;
  readonly stroke: number;
}

const DEFAULT_THEME: Renderer2DTheme = {
  background: 0x0a1020,
  grid: 0x1b2a44,
  fluid: 0x4fc3f7,
  smoke: 0xb9c6d8,
  stroke: 0x0a1020,
};

export interface BoxSpec {
  /** 世界坐标（左下角），Y 向上。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: number;
  readonly alpha?: number;
}

export interface Renderer2DViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly theme?: Partial<Renderer2DTheme>;
}

/**
 * 2D 视图（Pixi.js）。
 *
 * 关键设计：整个场景塞进一个「翻转 + 缩放」的容器里，坐标直接用物理世界单位
 * （Y 向上），这样物理层不需要为渲染做任何坐标转换，2D/3D 视图也共用同一套世界坐标。
 *
 * DrawCall 控制：建筑用独立 Graphics 但共享同一批纹理/着色器（Pixi 会合批），
 * 流体与烟雾各一个 ParticleContainer，整屏通常 5~12 个 DrawCall。
 */
export class Renderer2DView implements ViewAdapter {
  readonly id = 'render2d';
  readonly order = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly theme: Renderer2DTheme;
  private app: Application | null = null;
  private root: Container | null = null;
  private gridGfx: Graphics | null = null;
  private highlightGfx: Graphics | null = null;
  private boxLayer: Container | null = null;
  private fluidLayer: ParticleContainer | null = null;
  private smokeLayer: ParticleContainer | null = null;
  private fluidParticles: Particle[] = [];
  private smokeParticles: Particle[] = [];
  private readonly boxes = new Map<string, Graphics>();
  private texture: Texture | null = null;
  private engine: Engine | null = null;
  private profile: QualityProfile | null = null;
  private bounds: PhysicsBounds | null = null;
  private active = true;
  private scale = 40;
  private originX = 0;
  private originY = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private lastDpr = 1;
  private centerX = 0;
  private centerY = 0;
  private highlight: BoxSpec | null = null;

  constructor(options: Renderer2DViewOptions) {
    this.canvas = options.canvas;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
  }

  async attach(context: ViewContext): Promise<void> {
    this.engine = context.engine;
    this.profile = context.profile;
    this.bounds = context.engine.bounds;

    const app = new Application();
    await app.init({
      canvas: this.canvas,
      width: this.cssWidth,
      height: this.cssHeight,
      background: this.theme.background,
      antialias: context.profile.antialias,
      resolution: Math.min(context.caps.devicePixelRatio, context.profile.maxPixelRatio),
      autoDensity: true,
      preference: 'webgl',
      powerPreference: 'high-performance',
      autoStart: false,
    });
    app.ticker.stop();
    this.app = app;

    this.texture = createRadialTexture(32);

    this.root = new Container();
    app.stage.addChild(this.root);

    this.gridGfx = new Graphics();
    this.root.addChild(this.gridGfx);
    this.boxLayer = new Container();
    this.root.addChild(this.boxLayer);

    this.fluidLayer = new ParticleContainer({
      dynamicProperties: { position: true, scale: true, color: true },
    });
    this.root.addChild(this.fluidLayer);

    this.smokeLayer = new ParticleContainer({
      dynamicProperties: { position: true, scale: true, color: true },
    });
    this.root.addChild(this.smokeLayer);

    this.highlightGfx = new Graphics();
    this.root.addChild(this.highlightGfx);

    this.ensurePool(this.fluidLayer, this.fluidParticles, context.profile.fluidParticles, 0.24, this.theme.fluid);
    this.ensurePool(this.smokeLayer, this.smokeParticles, context.profile.smokeParticles, 0.4, this.theme.smoke);

    this.drawGrid();
    this.layout(this.cssWidth, this.cssHeight);
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.lastDpr = dpr;
    if (this.app === null || this.profile === null) return;
    const resolution = Math.min(dpr, this.profile.maxPixelRatio);
    this.app.renderer.resize(this.cssWidth, this.cssHeight, resolution);
    this.layout(this.cssWidth, this.cssHeight);
    this.drawGrid();
  }

  render(frame: ViewFrame): void {
    void frame;
    if (!this.active || this.app === null) return;
    this.updateFluid();
    this.updateSmoke();
    this.updateHighlight();
    this.app.render();
  }

  applyProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.resize(this.cssWidth, this.cssHeight, this.lastDpr);
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  upsertBox(id: string, spec: BoxSpec): void {
    if (this.boxLayer === null) return;
    let gfx = this.boxes.get(id);
    if (gfx === undefined) {
      gfx = new Graphics();
      this.boxLayer.addChild(gfx);
      this.boxes.set(id, gfx);
    }
    gfx.clear();
    gfx.rect(spec.x, spec.y, spec.width, spec.height).fill({ color: spec.color, alpha: spec.alpha ?? 1 });
    gfx.rect(spec.x, spec.y, spec.width, spec.height).stroke({ width: 0.06, color: this.theme.stroke, alpha: 0.9 });
  }

  removeBox(id: string): void {
    const gfx = this.boxes.get(id);
    if (gfx === undefined) return;
    gfx.destroy();
    this.boxes.delete(id);
  }

  clearBoxes(): void {
    for (const gfx of this.boxes.values()) gfx.destroy();
    this.boxes.clear();
  }

  setHighlight(spec: BoxSpec | null): void {
    this.highlight = spec;
  }

  /** 屏幕像素 → 世界坐标，用于点击放置。 */
  screenToWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.originX) / this.scale + this.centerX,
      y: (this.originY - py) / this.scale + this.centerY,
    };
  }

  dispose(): void {
    this.clearBoxes();
    this.fluidParticles = [];
    this.smokeParticles = [];
    this.texture?.destroy();
    this.texture = null;
    this.app?.destroy(false, { children: true });
    this.app = null;
    this.root = null;
    this.engine = null;
  }

  private layout(width: number, height: number): void {
    if (this.root === null || this.bounds === null) return;
    const worldWidth = this.bounds.max.x - this.bounds.min.x;
    const worldHeight = this.bounds.max.y - this.bounds.min.y;
    this.scale = Math.min(width / worldWidth, height / worldHeight) * 0.94;
    this.centerX = (this.bounds.min.x + this.bounds.max.x) / 2;
    this.centerY = (this.bounds.min.y + this.bounds.max.y) / 2;
    this.originX = width / 2;
    this.originY = height / 2;
    this.root.pivot.set(this.centerX, this.centerY);
    this.root.position.set(this.originX, this.originY);
    this.root.scale.set(this.scale, -this.scale);
  }

  private drawGrid(): void {
    const gfx = this.gridGfx;
    const bounds = this.bounds;
    if (gfx === null || bounds === null) return;
    gfx.clear();
    const step = 2;
    for (let x = bounds.min.x; x <= bounds.max.x + 0.001; x += step) {
      gfx.moveTo(x, bounds.min.y).lineTo(x, bounds.max.y);
    }
    for (let y = bounds.min.y; y <= bounds.max.y + 0.001; y += step) {
      gfx.moveTo(bounds.min.x, y).lineTo(bounds.max.x, y);
    }
    gfx.stroke({ width: 0.03, color: this.theme.grid, alpha: 0.55 });
    gfx.rect(bounds.min.x, bounds.min.y, bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
    gfx.stroke({ width: 0.06, color: this.theme.grid, alpha: 0.9 });
  }

  private ensurePool(
    container: ParticleContainer,
    pool: Particle[],
    capacity: number,
    radius: number,
    tint: number,
  ): void {
    const texture = this.texture;
    if (texture === null) return;
    const needed = Math.max(1, capacity);
    while (pool.length < needed) {
      const particle = new Particle({ texture, tint, alpha: 1, anchorX: 0.5, anchorY: 0.5 });
      particle.scaleX = (radius * 2) / texture.width;
      particle.scaleY = (radius * 2) / texture.height;
      pool.push(particle);
      container.addParticle(particle);
    }
  }

  private updateFluid(): void {
    const engine = this.engine;
    const layer = this.fluidLayer;
    if (engine === null || layer === null) return;
    const positions = engine.fluidPositions;
    const count = positions === null ? 0 : engine.fluidCount;
    const pool = this.fluidParticles;
    for (let i = 0; i < pool.length; i += 1) {
      const particle = pool[i];
      if (particle === undefined) continue;
      if (i >= count || positions === null) {
        particle.scaleX = 0;
        particle.scaleY = 0;
        continue;
      }
      particle.x = positions[i * 3] ?? 0;
      particle.y = positions[i * 3 + 1] ?? 0;
      const depth = 1 + (positions[i * 3 + 2] ?? 0) * 0.04;
      particle.scaleX = ((0.24 * 2) / (this.texture?.width ?? 32)) * depth;
      particle.scaleY = particle.scaleX;
    }
  }

  private updateSmoke(): void {
    const engine = this.engine;
    const layer = this.smokeLayer;
    if (engine === null || layer === null) return;
    const data = engine.world.smoke.renderData;
    const count = engine.world.smoke.count;
    const pool = this.smokeParticles;
    const base = 1 / (this.texture?.width ?? 32);
    for (let i = 0; i < pool.length; i += 1) {
      const particle = pool[i];
      if (particle === undefined) continue;
      if (i >= count) {
        particle.scaleX = 0;
        particle.scaleY = 0;
        continue;
      }
      const offset = i * SMOKE_STRIDE;
      particle.x = data[offset] ?? 0;
      particle.y = data[offset + 1] ?? 0;
      const size = data[offset + 3] ?? 0.4;
      const life = data[offset + 4] ?? 0;
      particle.scaleX = size * 2 * base;
      particle.scaleY = particle.scaleX;
      particle.alpha = Math.max(0, 1 - life) * 0.65;
    }
  }

  private updateHighlight(): void {
    const gfx = this.highlightGfx;
    if (gfx === null) return;
    gfx.clear();
    const spec = this.highlight;
    if (spec === null) return;
    gfx.rect(spec.x, spec.y, spec.width, spec.height).fill({ color: spec.color, alpha: 0.28 });
    gfx.rect(spec.x, spec.y, spec.width, spec.height).stroke({ width: 0.08, color: spec.color, alpha: 0.95 });
  }
}
