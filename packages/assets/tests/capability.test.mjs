/**
 * 能力探测测试。
 *
 * 每条断言背后都是一类真实设备：
 * - 骁龙/天玑中高端：ASTC + wasm → KTX2 可用
 * - 老 WebView：只有 ETC2、无 ASTC → KTX2 仍可用（ETC2 也是 GPU 压缩）
 * - 某省电模式：扩展全被掐 → 能解码但**不该用** KTX2（会更大）
 * - 禁 wasm 的环境：两样都得降级
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { conservativeCapabilities, describeCapabilities, probeAssetCapabilities } from '../dist/index.js';

/** 假的 WebGL 上下文：只回答「有没有这个扩展」。 */
function fakeGl(names) {
  const set = new Set(names);
  return { getExtension: (name) => (set.has(name) ? {} : null) };
}

test('没有 GL 上下文时退化成「只支持未压缩」', () => {
  const caps = probeAssetCapabilities(null, false);
  assert.equal(caps.ktx2, false);
  assert.equal(caps.draco, typeof WebAssembly === 'object');
  assert.equal(caps.reasons.length > 0, true);
});

test('ASTC + wasm + WebGL2 → KTX2 与 DRACO 都可用', () => {
  const caps = probeAssetCapabilities(fakeGl(['WEBGL_compressed_texture_astc']), true);
  assert.equal(caps.astc, true);
  assert.equal(caps.ktx2, true);
  assert.equal(caps.draco, true);
  assert.deepEqual(caps.reasons, []);
});

test('只有 ETC2 也算有 GPU 压缩，KTX2 仍可用', () => {
  const caps = probeAssetCapabilities(fakeGl(['WEBGL_compressed_texture_etc']), true);
  assert.equal(caps.etc2, true);
  assert.equal(caps.ktx2, true);
});

test('能解码但一种压缩格式都没有 → 主动放弃 KTX2', () => {
  const caps = probeAssetCapabilities(fakeGl([]), true);
  assert.equal(caps.wasm, true);
  assert.equal(caps.ktx2, false);
  assert.equal(caps.draco, true);
  assert.equal(
    caps.reasons.some((r) => r.includes('反而更大')),
    true,
  );
});

test('S3TC 的两种扩展名写法都认（WebGL1 无前缀 / WebGL2 有前缀）', () => {
  assert.equal(probeAssetCapabilities(fakeGl(['EXT_texture_compression_s3tc']), true).s3tc, true);
  assert.equal(probeAssetCapabilities(fakeGl(['WEBGL_compressed_texture_s3tc']), true).s3tc, true);
});

test('PVRTC 的 sRGB 变体也认', () => {
  const caps = probeAssetCapabilities(fakeGl(['WEBGL_compressed_texture_pvrtc_srgb']), true);
  assert.equal(caps.pvrtc, true);
});

test('不是 WebGL2 时 KTX2 降级（sRGB/mip 链支持不完整）', () => {
  const caps = probeAssetCapabilities(fakeGl(['WEBGL_compressed_texture_astc']), false);
  assert.equal(caps.ktx2, false);
  assert.equal(caps.draco, true);
  assert.equal(
    caps.reasons.some((r) => r.includes('WebGL2')),
    true,
  );
});

test('conservativeCapabilities 明确标出原因', () => {
  const caps = conservativeCapabilities('测试原因');
  assert.deepEqual(caps.reasons, ['测试原因']);
  assert.equal(caps.astc, false);
});

test('describeCapabilities 能一眼看出走了哪条路', () => {
  const rich = describeCapabilities(probeAssetCapabilities(fakeGl(['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc']), true));
  assert.match(rich, /KTX2 可用/);
  assert.match(rich, /ASTC\/ETC2/);

  const poor = describeCapabilities(probeAssetCapabilities(fakeGl([]), true));
  assert.match(poor, /KTX2 降级/);
  assert.match(poor, /无 GPU 压缩格式/);
});
