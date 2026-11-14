import { Texture } from 'pixi.js';

/**
 * 程序化生成圆形贴图，避免依赖外部图片资源：
 * 半开源引擎里最怕的就是「npm 装完少一张 png」。
 */
export function createRadialTexture(size = 32): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('[tabby/render2d] 无法创建 2D 上下文生成粒子贴图');
  }
  const radius = size / 2;
  const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return Texture.from(canvas);
}
