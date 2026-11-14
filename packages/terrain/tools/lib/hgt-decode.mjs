// SRTM .hgt 解析：int16 大端，行 0 是最北一行，无文件头。
// 常见两种规格：1201×1201（3 arc-second）与 3601×3601（1 arc-second）。
// void 值 -32768 表示无数据，需要按邻近插值或直接跳过。
const VOID = -32768;

export function decodeHgt(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const perSide = Math.sqrt(buf.length / 2);
  if (!Number.isInteger(perSide)) {
    throw new Error(`[terrain] .hgt 文件长度 ${buf.length} 不是 2×N² 的结构`);
  }
  if (perSide !== 1201 && perSide !== 3601 && perSide !== 601) {
    throw new Error(`[terrain] 非预期的 .hgt 规格 ${perSide}×${perSide}（常见 1201/3601）`);
  }

  const heights = new Int16Array(perSide * perSide);
  let voidCount = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i += 1) {
    const v = buf.readInt16BE(i * 2);
    heights[i] = v;
    if (v === VOID) {
      voidCount += 1;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return { width: perSide, height: perSide, heights, minElevation: min, maxElevation: max, voidCount, isMeters: true };
}
