# 资产管线（KTX2 / DRACO）

> 一句话：**解码器永远不进主包，能力探测永远不猜平台。**

## 为什么这里曾经是空的

这个仓库原本一个资产文件都没有 —— 所有画面都是程序化生成的（Pixi 画方块、Three 画 box 和点）。
所以「压缩纹理加载器」很容易做成一个**看起来对、实际没跑过**的模块。这一版的做法是：
先造出真的 ktx2/png/glb（`tools/make-test-assets.mjs`），再让加载链路在 playground 里被真的跑一遍。

## 三层，分得很硬

| 层 | 文件 | 职责 | 能在 Node 里测吗 |
|---|---|---|---|
| 能力探测 | `capability.ts` | 这台设备**能不能**用 ASTC/ETC2/S3TC、能不能跑 wasm | 能（注入假 GL） |
| 策略 | `variants.ts` | 按能力排候选链（ktx2 → png → jpg） | 能（纯函数） |
| 执行与缓存 | `cache.ts` / `three-host.ts` | 引用计数、宽限期回收、并发合并、失败缓存 | `cache.ts` 能 |

分开的理由：策略要能在诊断面板上被**显示**（「这台机器会走哪条路」），也要能在测试里
被**断言**（顺序错了就是错了）。把策略塞进加载器里，这两件事都做不了。

## 解码器放在哪

```
apps/<app>/public/decoders/
  basis_transcoder.js    57KB
  basis_transcoder.wasm 515KB
  draco_decoder.wasm    279KB
  draco_wasm_wrapper.js  57KB
  README.md                    ← 来源与 Apache-2.0 许可，必须一起发
```

`draco_decoder.js`（asm.js 回退，719KB）**不拷**：加载器显式写死
`setDecoderConfig({ type: 'wasm' })`，没有 wasm 的设备改走「未压缩网格」候选，
所以那个文件永远不会被 fetch。确实需要回退时给脚本加 `--with-js-fallback`。

用脚本从 three 里拷：

```bash
node tools/copy-decoders.mjs apps/playground/public/decoders
```

脚本会强制一起拷 `README.md`（注明来源与 Apache-2.0 许可）。再分发不带 LICENSE 是最常见的合规事故。

**这些文件不在 JS 产物里。** 别用 `grep basis_transcoder` 验证 —— `KTX2Loader` 那个 chunk
里本来就有 `basis_transcoder.js/.wasm` 这两个**路径字符串**（它得知道去哪 fetch），一定会命中。
正确的验证方式是看「有没有把 500KB 的 wasm 编码进 JS」：

```bash
# 1. 解码器文件确实躺在 dist 里，运行时 fetch 得到
ls apps/playground/dist/decoders

# 2. JS 里搜 base64 形式的 wasm 魔数 AGFzbQ。只应命中 1 处 ——
#    那是 KTX2Loader 自带的几 KB zstd（超压缩 KTX2 会用到），不是转码器本体。
grep -o "AGFzbQ" apps/playground/dist/assets/*.js | wc -l    # 期望 1
```

## 能力探测为什么不用 `isAndroid`

同名 GPU 在不同驱动上支持的压缩格式可能完全不同，而 UA 字符串连 GPU 型号都不一定能反映。
所以探测直接问 GL：

```ts
const ext = gl.getExtension('WEBGL_compressed_texture_astc');
const caps = probeAssetCapabilities(gl, isWebGL2);
```

判定规则：

- KTX2 需要 **WebGL2 + wasm + 至少一种压缩格式**。缺一条都不用 —— 解出来也没法上传。
- DRACO 只需要 wasm（解压到普通 BufferGeometry，与 GL 版本无关）。

## 候选链

```
纹理：crate.ktx2 → crate.png → crate.jpg     （ktx2 只在能力允许时排第一）
网格：crate.glb（draco 压在同一容器里） → crate-plain.glb
```

每回退一次 `fallbacks += 1`。**这个数字比日志有用**：它直接告诉你线上设备退化到了什么程度。
诊断面板把它和 `hits/misses/coalesced` 并排显示。

## 缓存的三条规则

1. **引用计数**：`acquire` +1、`release` -1。同一张纹理被两处用，释放一处不会真的 dispose。
2. **宽限期**（默认 5s）：归零后不立刻销毁，因为下一帧可能又要点它 —— 这正是「切场景时
   纹理闪一下」的成因。等待期内重新 `acquire` 会记为 `revived`。
3. **并发合并**：同一 key 的并发请求共享一个 Promise，记为 `coalesced`。
   没有这条，一屏 40 个相同图标会发 40 次请求。

## 建筑贴图怎么接

```ts
const ok = await view3d.loadBuildingTexture('./test-assets/crate', ['png']);
```

走的就是上面的候选链。失败时返回 `false` 并记下 `textureError`（诊断面板可见），
场景继续用纯色 —— 纹理是锦上添花，不该把整个场景拖黑。

## 生成测试资产

```bash
node tools/make-test-assets.mjs            # 输出到 apps/playground/public/test-assets
```

产出四个小文件（几 KB）：

| 文件 | 用途 |
|---|---|
| `crate.ktx2` | ETC1S + mip 链，验证 GPU 压缩纹理路径 |
| `crate.png` | 同图未压缩，验证回退路径 |
| `crate.glb` | DRACO 压缩网格 |
| `crate-plain.glb` | 同网格未压缩，验证回退路径 |

PNG 编码是手写的（只做 filter 0）。注释里写清了这一点，所以它不是通用编码器 —— 只服务这个脚本。

## 三条自检

1. **删掉 `public/decoders/` 之后页面还能出画面吗？** 应该能：候选链会退到未压缩版，
   `fallbacks` 增加。如果白屏，说明回退路径是假的。
2. **弱网下首屏会等解码器吗？** 不会：解码器只在第一次真要加载 ktx2/draco 时 fetch。
   验证方式是把网络限速到 3G，看首屏交互时间是否受影响。
3. **主包里有没有 wasm 的 base64？** 有些打包器会把 `.wasm` 内联成 base64 塞进 JS。
   `grep -c "AGFzbQ" dist/assets/*.js`（wasm 魔数的 base64 头）应该是 0。
