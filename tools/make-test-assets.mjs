#!/usr/bin/env node
/**
 * 生成 playground 用的测试资产。
 *
 * ## 为什么要自己造资产
 *
 * 这个仓库里原本**一个资产文件都没有** —— 所有画面都是程序化生成的图形。
 * 那「KTX2 / DRACO 加载器」就没有任何可加载的东西，只能靠单元测试假装验证。
 * 所以这里现场造一套最小但真实的资产，让加载链路能在浏览器里被真的跑一遍：
 *
 * | 文件 | 用途 |
 * |---|---|
 * | `crate.ktx2` | ETC1S + mip 链，验证 GPU 压缩纹理路径 |
 * | `crate.png`  | 同图未压缩版，验证回退路径 |
 * | `crate.glb`  | DRACO 压缩网格（由 gltf-transform 压） |
 * | `crate-plain.glb` | 同网格未压缩版，验证回退路径 |
 *
 * 四个文件都很小（几 KB），够验证也够放进仓库。
 *
 * ## 为什么 PNG 编码是手写的
 *
 * 只为了生成一张 64×64 的棋盘格就引一个图像库不划算，而 Node 自带 zlib，
 * PNG 的 filter-0 编码只有二十来行。注释里写清了「只做 filter 0」，
 * 所以它不是通用 PNG 编码器 —— 只服务这个脚本。
 *
 * 用法：`node tools/make-test-assets.mjs [输出目录]`
 * 默认输出到 `apps/playground/public/test-assets`。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { encodeToKTX2 } from 'ktx2-encoder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(root, 'apps/playground/public/test-assets'));
const tmpDir = join(outDir, '.tmp');

const SIZE = 64;
/** 棋盘格每格边长（像素）。8 的倍数能让 ETC1S 的块边界对齐，避免糊边。 */
const CELL = 8;

// ---------------------------------------------------------------- 像素与 PNG

/** 造一张棋盘格 RGBA。冷暖两色交替，方便一眼看出纹理有没有被正确采样。 */
function makeChecker() {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const at = (y * SIZE + x) * 4;
      const on = ((x / CELL) | 0) + ((y / CELL) | 0);
      const light = on % 2 === 0;
      rgba[at] = light ? 220 : 40;
      rgba[at + 1] = light ? 180 : 60;
      rgba[at + 2] = light ? 90 : 120;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 8bit RGBA、filter 0、单个 IDAT。够用，且不引第三方依赖。 */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 = None
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- GLB

/** 立方体的 6 个面：每面 4 顶点 + 2 三角形。法线不做，靠材质双面渲染。 */
function makeCubeGeometry() {
  const half = 0.5;
  const faces = [
    { normal: [0, 0, 1], corners: [[-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half]] },
    { normal: [0, 0, -1], corners: [[half, -half, -half], [-half, -half, -half], [-half, half, -half], [half, half, -half]] },
    { normal: [1, 0, 0], corners: [[half, -half, half], [half, -half, -half], [half, half, -half], [half, half, half]] },
    { normal: [-1, 0, 0], corners: [[-half, -half, -half], [-half, -half, half], [-half, half, half], [-half, half, -half]] },
    { normal: [0, 1, 0], corners: [[-half, half, half], [half, half, half], [half, half, -half], [-half, half, -half]] },
    { normal: [0, -1, 0], corners: [[-half, -half, -half], [half, -half, -half], [half, -half, half], [-half, -half, half]] },
  ];
  const positions = [];
  const uvs = [];
  const indices = [];
  const minPos = [Infinity, Infinity, Infinity];
  const maxPos = [-Infinity, -Infinity, -Infinity];
  for (const [faceIndex, face] of faces.entries()) {
    const base = faceIndex * 4;
    for (const [cornerIndex, corner] of face.corners.entries()) {
      positions.push(corner[0], corner[1], corner[2]);
      for (let axis = 0; axis < 3; axis += 1) {
        minPos[axis] = Math.min(minPos[axis], corner[axis]);
        maxPos[axis] = Math.max(maxPos[axis], corner[axis]);
      }
      // UV 让棋盘格在每面都是完整一张
      uvs.push(cornerIndex === 1 || cornerIndex === 2 ? 1 : 0, cornerIndex >= 2 ? 1 : 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, uvs, indices, minPos, maxPos, vertexCount: faces.length * 4 };
}

function glbBuffer(geometry, texturePng) {
  const { positions, uvs, indices, minPos, maxPos, vertexCount } = geometry;
  const positionBytes = Buffer.alloc(positions.length * 4);
  positions.forEach((value, index) => positionBytes.writeFloatLE(value, index * 4));
  const uvBytes = Buffer.alloc(uvs.length * 4);
  uvs.forEach((value, index) => uvBytes.writeFloatLE(value, index * 4));
  const indexBytes = Buffer.alloc(indices.length * 2);
  indices.forEach((value, index) => indexBytes.writeUInt16LE(value, index * 2));

  // bufferView 的 byteOffset 必须 4 字节对齐
  const align4 = (n) => (n + 3) & ~3;
  const posOffset = 0;
  const uvOffset = align4(posOffset + positionBytes.length);
  const idxOffset = align4(uvOffset + uvBytes.length);
  const texOffset = align4(idxOffset + indexBytes.length);
  const total = align4(texOffset + texturePng.length);

  const bin = Buffer.alloc(total);
  positionBytes.copy(bin, posOffset);
  uvBytes.copy(bin, uvOffset);
  indexBytes.copy(bin, idxOffset);
  texturePng.copy(bin, texOffset);

  const json = {
    asset: { version: '2.0', generator: 'tabby-engine/tools/make-test-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Crate' }],
    meshes: [
      {
        name: 'Crate',
        primitives: [
          {
            attributes: { POSITION: 0, TEXCOORD_0: 1 },
            indices: 2,
            material: 0,
            // 双面：这样即使不生成法线，从内部看也不是黑洞
            mode: 4,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'CrateMat',
        doubleSided: true,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.05, roughnessFactor: 0.85 },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3',
        min: minPos,
        max: maxPos,
      },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes.length, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: indexBytes.length, target: 34963 },
      { buffer: 0, byteOffset: texOffset, byteLength: texturePng.length },
    ],
    buffers: [{ byteLength: total }],
  };

  let jsonText = JSON.stringify(json);
  // JSON chunk 也要 4 字节对齐，用空格补
  while (Buffer.byteLength(jsonText, 'utf8') % 4 !== 0) jsonText += ' ';
  const jsonBytes = Buffer.from(jsonText, 'utf8');

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

// ------------------------------------------------------------------- 主流程

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const rgba = makeChecker();
  const png = encodePng(rgba, SIZE, SIZE);
  writeFileSync(join(outDir, 'crate.png'), png);
  console.log(`crate.png       ${kb(png.length)}`);

  const ktx2 = await encodeToKTX2(rgba, {
    isUASTC: false,
    generateMipmap: true,
    // Node 里没有 WebCodecs 的 ImageDecoder，直接把已经解好的 RGBA 交回去
    imageDecoder: async () => ({ width: SIZE, height: SIZE, data: rgba }),
  });
  writeFileSync(join(outDir, 'crate.ktx2'), ktx2);
  console.log(`crate.ktx2      ${kb(ktx2.length)}`);

  const geometry = makeCubeGeometry();
  const plainGlb = glbBuffer(geometry, png);
  writeFileSync(join(outDir, 'crate-plain.glb'), plainGlb);
  console.log(`crate-plain.glb ${kb(plainGlb.length)}`);

  // DRACO 压缩交给 gltf-transform：KHR_draco_mesh_compression 的容器细节很多，
  // 自己手写容易在 accessor 的 count 与 bufferView 的 byteStride 上出错。
  const tmpIn = join(tmpDir, 'in.glb');
  const tmpOut = join(tmpDir, 'out.glb');
  writeFileSync(tmpIn, plainGlb);
  const cli = spawnSync('pnpm', ['dlx', '@gltf-transform/cli@4', 'draco', tmpIn, tmpOut], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    cwd: root,
  });
  if (cli.status !== 0) {
    console.error('gltf-transform draco 失败：');
    console.error(cli.stdout);
    console.error(cli.stderr);
    process.exitCode = 1;
    return;
  }
  const dracoGlb = readFileSync(tmpOut);
  writeFileSync(join(outDir, 'crate.glb'), dracoGlb);
  console.log(`crate.glb       ${kb(dracoGlb.length)}  (draco 压缩)`);

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n输出目录：${outDir}`);
  console.log(`网格体积：${kb(plainGlb.length)} → ${kb(dracoGlb.length)}`);
}

await main();
