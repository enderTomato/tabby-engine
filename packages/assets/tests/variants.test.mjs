/**
 * 候选链策略测试。
 *
 * 这一层是**策略**，所以测试断言的是「顺序」与「什么时候根本不排」，
 * 而不是「能不能加载出来」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { meshCandidates, resolveTextureChain, stripExtension, textureCandidates } from '../dist/index.js';

const withKtx2 = { ktx2: true, draco: true, wasm: true, webgl2: true, astc: true, etc2: false, s3tc: false, pvrtc: false, reasons: [] };
const withoutKtx2 = { ...withKtx2, ktx2: false, astc: false };
const withoutDraco = { ...withKtx2, draco: false };

test('stripExtension 不吃掉目录名里的点', () => {
  assert.equal(stripExtension('a/b/c.png'), 'a/b/c');
  assert.equal(stripExtension('a/b.v2/c'), 'a/b.v2/c');
  assert.equal(stripExtension('tex.ktx2'), 'tex');
  assert.equal(stripExtension('noext'), 'noext');
});

test('KTX2 可用时排在最前，未压缩在后', () => {
  assert.deepEqual(resolveTextureChain('tex/rock', withKtx2), ['tex/rock.ktx2', 'tex/rock.png', 'tex/rock.jpg']);
});

test('KTX2 不可用时它根本不出现（不是排后面碰运气）', () => {
  const chain = resolveTextureChain('tex/rock', withoutKtx2);
  assert.deepEqual(chain, ['tex/rock.png', 'tex/rock.jpg']);
  assert.equal(
    chain.some((url) => url.endsWith('.ktx2')),
    false,
  );
});

test('已经带 .ktx2 的基名不会被拼成 .ktx2.ktx2', () => {
  assert.equal(textureCandidates('tex/rock.ktx2', withKtx2).ktx2, 'tex/rock.ktx2');
});

test('未压缩格式的顺序尊重调用方给的原序', () => {
  assert.deepEqual(resolveTextureChain('tex/rock', withKtx2, ['webp', 'png']), [
    'tex/rock.ktx2',
    'tex/rock.webp',
    'tex/rock.png',
  ]);
});

test('一个候选都没有时立刻抛，而不是静默返回空链', () => {
  assert.throws(() => resolveTextureChain('tex/rock', withoutKtx2, []), /没有任何可用的候选格式/);
});

test('网格：DRACO 可用时压缩版优先，未压缩留作备用', () => {
  const chain = meshCandidates('a.glb', 'a-plain.glb', withKtx2);
  assert.deepEqual(chain, [
    { url: 'a.glb', compressed: true },
    { url: 'a-plain.glb', compressed: false },
  ]);
});

test('网格：DRACO 可用但没给备用文件，就只有一个候选', () => {
  assert.deepEqual(meshCandidates('a.glb', null, withKtx2), [{ url: 'a.glb', compressed: true }]);
});

test('网格：DRACO 不可用时退到未压缩备用文件', () => {
  const chain = meshCandidates('a.glb', 'a-plain.glb', withoutDraco);
  assert.deepEqual(chain, [{ url: 'a-plain.glb', compressed: false }]);
});

test('网格：DRACO 不可用又没有备用文件 → 明确报错', () => {
  assert.throws(() => meshCandidates('a.glb', null, withoutDraco), /既不能解码又没有未压缩备用文件/);
});
