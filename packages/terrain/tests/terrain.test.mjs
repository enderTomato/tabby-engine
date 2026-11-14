import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HeightField, buildChunkMesh, selectLodStep, TerrainEditor, createGeoTransform, srtmTileBBox, bakeSlope, bakeBuildableMask, buildableRatio, parseGeoTiff, rasterBBox, metersToU16 } from '../dist/index.js';

const RANGE = { minElevation: 0, maxElevation: 1000 };

/** 造一张有斜坡的高度场：海拔 = col × 10 米。 */
function makeField(width = 64, height = 64) {
  const data = new Uint16Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      data[row * width + col] = metersToU16(col * 10, RANGE);
    }
  }
  return new HeightField(data, width, height, 30, RANGE);
}

test('网格：顶点与索引数量符合 (N+1)² 与 N²×2', () => {
  const field = makeField();
  const mesh = buildChunkMesh(field, 0, 0, { chunkSize: 8, skirtDepth: 0 });
  assert.equal(mesh.vertexCount, 81, '9×9 顶点');
  assert.equal(mesh.indexCount, 8 * 8 * 6, '64 个格子 × 2 三角形 × 3 索引');
  assert.equal(mesh.positions.length, 81 * 3);
});

test('网格：相邻块在同级 LOD 下边界顶点完全重合（无裂缝）', () => {
  const field = makeField();
  const left = buildChunkMesh(field, 0, 0, { chunkSize: 8, skirtDepth: 0 });
  const right = buildChunkMesh(field, 1, 0, { chunkSize: 8, skirtDepth: 0 });

  // 左块最右一列 x=8，右块最左一列 x=0，n=8 → 顶点索引 8 与 72
  const n = 8;
  for (let z = 0; z <= n; z += 1) {
    const li = (z * (n + 1) + n) * 3;
    const ri = (z * (n + 1)) * 3;
    assert.equal(left.positions[li], right.positions[ri], `第 ${z} 行 x 不一致`);
    assert.equal(left.positions[li + 1], right.positions[ri + 1], `第 ${z} 行 y 不一致`);
    assert.equal(left.positions[li + 2], right.positions[ri + 2], `第 ${z} 行 z 不一致`);
  }
});

test('网格：裙边顶点比地面低 skirtDepth，且索引不越界', () => {
  const field = makeField();
  const mesh = buildChunkMesh(field, 0, 0, { chunkSize: 8, skirtDepth: 5, verticalScale: 1 });
  assert.equal(mesh.vertexCount, 81 + 4 * 9);
  // 第一个裙边顶点对应地面顶点 0
  const groundY = mesh.positions[1];
  const skirtY = mesh.positions[(81 * 3) + 1];
  assert.ok(Math.abs(groundY - skirtY - 5) < 1e-4, `裙边应下垂 5 米：${groundY} → ${skirtY}`);

  for (let i = 0; i < mesh.indexCount; i += 1) {
    assert.ok(mesh.indices[i] < mesh.vertexCount, `索引 ${mesh.indices[i]} 越界（顶点数 ${mesh.vertexCount}）`);
  }
});

test('网格：垂直夸张只改 y，不改 x/z', () => {
  const field = makeField();
  const plain = buildChunkMesh(field, 0, 0, { chunkSize: 4, verticalScale: 1, skirtDepth: 0 });
  const exaggerated = buildChunkMesh(field, 0, 0, { chunkSize: 4, verticalScale: 2, skirtDepth: 0 });
  assert.equal(plain.positions[0], exaggerated.positions[0]);
  assert.ok(Math.abs(exaggerated.positions[1] - plain.positions[1] * 2) < 1e-3);
});

test('LOD：距离越远步长越大，近处保持原始精度', () => {
  const opts = { chunkSize: 32, cellSize: 2, maxScreenErrorPx: 2, fovY: (60 * Math.PI) / 180, viewportHeight: 800, maxSteps: 8 };
  const near = selectLodStep(10, 50, opts);
  const far = selectLodStep(3000, 50, opts);
  assert.equal(near, 1, '贴脸应该用最高精度');
  assert.ok(far > near, `远处步长 ${far} 应大于近处 ${near}`);
  assert.ok([1, 2, 4, 8].includes(far), '步长必须是 2 的幂');
});

test('编辑：抬升后中心最高、边缘归零（smoothstep 衰减）', () => {
  const field = makeField();
  const editor = new TerrainEditor(field, {}, 32);
  // 世界坐标：x=300 → col 10，边缘 x=390 → col 13
  const before = editor.getHeight(390, 300);
  const beforeCenter = editor.getHeight(300, 300);

  const changed = editor.raise(300, 300, 90, 20);
  assert.ok(changed > 0);

  const center = editor.getHeight(300, 300);
  const edge = editor.getHeight(390, 300);
  assert.ok(center > beforeCenter + 15, `中心应被抬高约 20 米：${beforeCenter} → ${center}`);
  assert.ok(Math.abs(edge - before) < 0.5, `边缘不该被抬升：${before} → ${edge}`);
});

test('编辑：diff 按索引升序，且只包含真正变化的格子', () => {
  const field = makeField();
  const editor = new TerrainEditor(field, {}, 32);
  editor.raise(100, 100, 60, 10);

  const diff = editor.exportDiff();
  assert.ok(diff.indices.length > 0);
  for (let i = 1; i < diff.indices.length; i += 1) {
    assert.ok(diff.indices[i] > diff.indices[i - 1], '索引必须严格升序（确定性要求）');
  }
  // 每个记录的格子确实变了
  for (let i = 0; i < diff.indices.length; i += 1) {
    assert.equal(field.data[diff.indices[i]], diff.values[i]);
  }
});

test('编辑：把地平整到当前值不产生新 diff（避免存档膨胀）', () => {
  const field = makeField();
  const editor = new TerrainEditor(field, {}, 32);
  editor.flatten(200, 200, 40, 200);
  const first = editor.exportDiff().indices.length;
  assert.ok(first > 0, '第一次平整应产生改动');

  // 再平一次到同样的值
  editor.flatten(200, 200, 40, 200);
  assert.equal(editor.exportDiff().indices.length, first, '重复平整同一高度不该新增条目');
});

test('编辑：diff 二进制往返一致', () => {
  const field = makeField();
  const editor = new TerrainEditor(field, {}, 32);
  editor.raise(200, 200, 80, 15);
  const diff = editor.exportDiff();

  const bytes = TerrainEditor.encodeDiff(diff);
  const back = TerrainEditor.decodeDiff(bytes);
  assert.equal(back.indices.length, diff.indices.length);
  for (let i = 0; i < diff.indices.length; i += 1) {
    assert.equal(back.indices[i], diff.indices[i]);
    assert.equal(back.values[i], diff.values[i]);
  }
});

test('编辑：diff 应用到另一张同参高度场，结果逐格一致', () => {
  const source = makeField();
  const editor = new TerrainEditor(source, {}, 32);
  editor.raise(150, 150, 70, 25);
  const diff = editor.exportDiff();

  const target = makeField();
  const applied = TerrainEditor.applyDiff(target, diff);
  assert.equal(applied, diff.indices.length);
  for (let i = 0; i < source.data.length; i += 1) {
    assert.equal(target.data[i], source.data[i], `第 ${i} 格不一致`);
  }
});

test('编辑：量化区间不匹配时拒绝应用 diff', () => {
  const source = makeField();
  const editor = new TerrainEditor(source, {}, 32);
  editor.raise(150, 150, 50, 10);
  const diff = editor.exportDiff();

  const other = new HeightField(new Uint16Array(64 * 64), 64, 64, 30, { minElevation: -500, maxElevation: 500 });
  assert.throws(() => TerrainEditor.applyDiff(other, diff), /量化区间不匹配/);
});

test('编辑：半径过大时抛错而不是静默截断', () => {
  const field = makeField();
  const editor = new TerrainEditor(field, { maxAffectedCells: 100 }, 32);
  assert.throws(() => editor.raise(100, 100, 5000, 10), /编辑半径过大/);
});

test('编辑：脏块按索引升序，且覆盖被改动的区域', () => {
  const field = makeField(); // 64×64，chunk 32 → 2×2 = 4 块
  const editor = new TerrainEditor(field, {}, 32);
  assert.equal(editor.chunksX, 2);
  editor.raise(60, 60, 40, 10);

  const dirty = editor.dirtyChunks;
  assert.ok(dirty.length > 0);
  for (let i = 1; i < dirty.length; i += 1) {
    assert.ok(dirty[i] > dirty[i - 1], '脏块必须升序');
  }
});

test('地理投影：等距圆柱往返精度在 1e-6 度以内', () => {
  const tf = createGeoTransform({ west: 116, south: 39, east: 117, north: 40 });
  assert.ok(Math.abs(tf.widthMeters - 111320 * Math.cos((39.5 * Math.PI) / 180)) < 1);
  assert.ok(Math.abs(tf.heightMeters - 111320) < 1);

  const p = tf.toLocal(116.5, 39.5);
  const back = tf.toGeo(p.x, p.z);
  assert.ok(Math.abs(back.lon - 116.5) < 1e-9);
  assert.ok(Math.abs(back.lat - 39.5) < 1e-9);
});

test('地理投影：墨卡托在两个纬度上都可逆', () => {
  const tf = createGeoTransform({ west: 0, south: 40, east: 1, north: 41 }, 'mercator');
  for (const lat of [40.1, 40.5, 40.9]) {
    const p = tf.toLocal(0.5, lat);
    const back = tf.toGeo(p.x, p.z);
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `${lat} → ${back.lat}`);
  }
});

test('SRTM 瓦片名解析：支持南半球与西经', () => {
  assert.deepEqual(srtmTileBBox('N39E116'), { west: 116, south: 39, east: 117, north: 40 });
  assert.deepEqual(srtmTileBBox('S34W058'), { west: -58, south: -34, east: -57, north: -33 });
  assert.throws(() => srtmTileBBox('bad'), /无法解析/);
});

test('派生图：坡度图与可建性掩膜一致', () => {
  // 造一个陡坡：每格高 30 米，cellSize 30 → 45°
  const data = new Uint16Array(16 * 16);
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) data[row * 16 + col] = metersToU16(col * 30, RANGE);
  }
  const field = new HeightField(data, 16, 16, 30, RANGE);
  const slope = bakeSlope(field);
  // 内部格子的坡度应接近 45° → 127/255
  const mid = slope[8 * 16 + 8];
  assert.ok(mid > 120 && mid < 135, `坡度值 ${mid} 偏离 45°`);

  const mask = bakeBuildableMask(field, { maxSlopeRad: (25 * Math.PI) / 180 });
  assert.ok(buildableRatio(mask) < 0.2, `45° 坡不该大面积可建，实际 ${buildableRatio(mask)}`);

  const flat = new HeightField(new Uint16Array(16 * 16), 16, 16, 30, RANGE);
  assert.equal(buildableRatio(bakeBuildableMask(flat)), 1, '平地应全部可建');
});

// ───────────────────────── GeoTIFF ─────────────────────────

/** 手搓一个最小未压缩 GeoTIFF，用来验证解析器真的能读字节。 */
function buildTiff({ width, height, values, bits = 16, signed = false, withGeo = false }) {
  const bytesPerSample = bits / 8;
  const pixelBytes = width * height * bytesPerSample;
  const entryCount = withGeo ? 11 : 9;
  const ifdSize = 2 + entryCount * 12 + 4;
  const extraStart = 8 + ifdSize;
  const extraSize = withGeo ? 48 : 0;
  const dataOffset = extraStart + extraSize;
  const total = dataOffset + pixelBytes;

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  u8[0] = 0x49;
  u8[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, entryCount, true);

  let at = 10;
  const writeEntry = (tag, type, count, value) => {
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
    at += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 1, bits);
  writeEntry(259, 3, 1, 1);
  writeEntry(273, 4, 1, dataOffset);
  writeEntry(277, 3, 1, 1);
  writeEntry(278, 4, 1, height);
  writeEntry(279, 4, 1, pixelBytes);
  // SampleFormat: 1=uint 2=int 3=float（缺省即 1，但测试要覆盖 int/float 必须写）
  writeEntry(339, 3, 1, bits === 32 && signed === null ? 3 : signed ? 2 : bits === 32 && values.some((v) => !Number.isInteger(v)) ? 3 : 1);
  if (withGeo) {
    writeEntry(33550, 12, 3, extraStart);
    writeEntry(33922, 12, 3, extraStart + 24);
  }
  view.setUint32(at, 0, true); // 没有下一个 IFD

  if (withGeo) {
    view.setFloat64(extraStart, 0.000277777, true); // 1 arc-second
    view.setFloat64(extraStart + 8, 0.000277777, true);
    view.setFloat64(extraStart + 16, 0, true);
    view.setFloat64(extraStart + 24, 116, true);
    view.setFloat64(extraStart + 32, 40, true);
    view.setFloat64(extraStart + 40, 0, true);
  }

  for (let i = 0; i < values.length; i += 1) {
    const o = dataOffset + i * bytesPerSample;
    if (bits === 16) {
      if (signed) view.setInt16(o, values[i], true);
      else view.setUint16(o, values[i], true);
    } else {
      view.setFloat32(o, values[i], true);
    }
  }
  return buffer;
}

test('GeoTIFF：解析未压缩 16bit 单波段', () => {
  const values = [1, 2, 3, 4, 5, 6];
  const raster = parseGeoTiff(buildTiff({ width: 3, height: 2, values }));
  assert.equal(raster.width, 3);
  assert.equal(raster.height, 2);
  assert.equal(raster.bitsPerSample, 16);
  assert.equal(raster.sampleFormat, 'uint');
  assert.deepEqual(Array.from(raster.data), values);
  assert.equal(raster.geoReferenced, false);
});

test('GeoTIFF：解析有符号 16bit（SRTM 的 -32768 void 值要能原样读到）', () => {
  const values = [-32768, 100, -5, 200, 300, 400];
  const raster = parseGeoTiff(buildTiff({ width: 3, height: 2, values, signed: true }));
  assert.equal(raster.sampleFormat, 'int');
  assert.deepEqual(Array.from(raster.data), values);
});

test('GeoTIFF：解析 Float32 单波段', () => {
  const values = [1.5, -2.25, 300.125, 0];
  const raster = parseGeoTiff(buildTiff({ width: 2, height: 2, values, bits: 32 }));
  assert.equal(raster.sampleFormat, 'float');
  for (let i = 0; i < values.length; i += 1) {
    assert.ok(Math.abs(raster.data[i] - values[i]) < 1e-5);
  }
});

test('GeoTIFF：读取地理参考并推导 bbox', () => {
  const raster = parseGeoTiff(buildTiff({ width: 2, height: 2, values: [1, 2, 3, 4], withGeo: true }));
  assert.equal(raster.geoReferenced, true);
  assert.ok(Math.abs(raster.tiepoint[0] - 116) < 1e-9);
  const bbox = rasterBBox(raster);
  assert.ok(bbox !== null);
  assert.ok(Math.abs(bbox.west - 116) < 1e-6);
  assert.ok(bbox.east > bbox.west);
  assert.ok(Math.abs(bbox.north - 40) < 1e-6);
  assert.ok(bbox.south < bbox.north);
});

test('GeoTIFF：非 TIFF 与 BigTIFF 都明确报错', () => {
  assert.throws(() => parseGeoTiff(new ArrayBuffer(4)), /文件太短/);
  const bad = new ArrayBuffer(16);
  new Uint8Array(bad)[0] = 0x00;
  assert.throws(() => parseGeoTiff(bad), /字节序标记无效/);

  const big = new DataView(new ArrayBuffer(16));
  new Uint8Array(big.buffer)[0] = 0x49;
  new Uint8Array(big.buffer)[1] = 0x49;
  big.setUint16(2, 43, true);
  assert.throws(() => parseGeoTiff(big.buffer), /BigTIFF/);
});

test('地形包导出的模块不引用任何渲染库', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const dep of deps) {
    assert.ok(!/three|pixi|vue|gsap/i.test(dep), `地形包不该依赖渲染库：${dep}`);
  }
});
