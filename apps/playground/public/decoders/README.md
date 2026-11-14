# 解码器（按需加载）

这些文件来自 three.js 的 `examples/jsm/libs/`，由 `tools/copy-decoders.mjs` 拷贝。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `basis_transcoder.*` | [basis_universal](https://github.com/BinomialLLC/basis_universal) | Apache-2.0 |
| `draco_decoder.wasm` / `draco_wasm_wrapper.js` | [draco](https://github.com/google/draco) | Apache-2.0 |

`draco_decoder.js`（asm.js 回退，719KB）默认**不拷**：加载器写死了 `type: 'wasm'`，
没有 wasm 的设备改走「未压缩网格」候选。要回退请加 `--with-js-fallback` 重跑脚本。

再分发时请保留上游 LICENSE。它们**不在**主包里，只在真正加载 KTX2 / DRACO 资源时按需 fetch。
