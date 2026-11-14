// ESRI ASCII Grid (.asc) 解析：文本头 + 从北到南逐行的栅格值。
// 头字段常见：ncols / nrows / xllcorner|yllcorner / cellsize / NODATA_value。
export function decodeAsc(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = {};
  let index = 0;
  while (index < lines.length && index < 10) {
    const parts = lines[index].trim().split(/\s+/);
    if (parts.length !== 2 || Number.isNaN(Number(parts[1]))) break;
    header[parts[0].toLowerCase()] = Number(parts[1]);
    index += 1;
  }

  const ncols = header.ncols;
  const nrows = header.nrows;
  if (!Number.isFinite(ncols) || !Number.isFinite(nrows)) {
    throw new Error('[terrain] .asc 缺少 ncols / nrows 头字段');
  }

  const nodata = header.nodata_value ?? -9999;
  const cellsize = header.cellsize ?? 1;
  const heights = new Float32Array(ncols * nrows);
  let filled = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let line = index; line < lines.length; line += 1) {
    const values = lines[line].trim().split(/\s+/);
    for (const raw of values) {
      if (filled >= heights.length) break;
      const v = Number(raw);
      const isVoid = !Number.isFinite(v) || v === nodata;
      heights[filled] = isVoid ? 0 : v;
      if (!isVoid) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      filled += 1;
    }
  }

  return {
    width: ncols,
    height: nrows,
    heights,
    minElevation: Number.isFinite(min) ? min : 0,
    maxElevation: Number.isFinite(max) ? max : 0,
    cellSizeMeters: cellsize,
    isMeters: true,
  };
}
