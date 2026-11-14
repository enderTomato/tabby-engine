import type { HeightField } from './height-field.js';
import type { TerrainChunk } from './types.js';

/** 按 chunkSize 切分整图。边缘块用最后有效值补齐，保证每块等长（GPU 上传友好）。 */
export function sliceIntoChunks(field: HeightField, chunkSize: number): TerrainChunk[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunksX = Math.ceil(field.width / size);
  const chunksY = Math.ceil(field.height / size);
  const out: TerrainChunk[] = [];
  for (let cy = 0; cy < chunksY; cy += 1) {
    for (let cx = 0; cx < chunksX; cx += 1) {
      const data = new Uint16Array(size * size);
      for (let y = 0; y < size; y += 1) {
        const srcRow = Math.min(cy * size + y, field.height - 1);
        for (let x = 0; x < size; x += 1) {
          const srcCol = Math.min(cx * size + x, field.width - 1);
          data[y * size + x] = field.data[srcRow * field.width + srcCol] ?? 0;
        }
      }
      out.push({ cx, cy, size, data });
    }
  }
  return out;
}

/** 替换路径模板里的占位符。 */
export function chunkPath(template: string, cx: number, cy: number, lod: number): string {
  return template.replace(/\{x\}/g, String(cx)).replace(/\{y\}/g, String(cy)).replace(/\{lod\}/g, String(lod));
}

/** 由整图尺寸与块尺寸推导块网格。 */
export function chunkGrid(width: number, height: number, chunkSize: number): { chunksX: number; chunksY: number } {
  return {
    chunksX: Math.ceil(width / chunkSize),
    chunksY: Math.ceil(height / chunkSize),
  };
}
