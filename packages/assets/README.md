# @tabby/assets

资源加载与降级。**解码器永远不进主包，能力探测永远不猜平台。**

```ts
import { probeAssetCapabilities, ThreeAssetHost } from '@tabby/assets';

const caps = probeAssetCapabilities(gl, isWebGL2);   // 只问能力，不问 UA
const host = new ThreeAssetHost({ renderer, decoderPaths: { basis: './decoders/', draco: './decoders/' }, caps });
const texture = await host.loadTexture('./tex/crate', ['png']);  // ktx2 → png 自动回退
```

## 模块

| 文件 | 职责 |
|---|---|
| `capability.ts` | 探测 ASTC/ETC2/S3TC/PVRTC/wasm；给出 `ktx2` / `draco` 两个结论位 |
| `variants.ts` | 按能力排候选链（纯函数，可单测） |
| `cache.ts` | 引用计数 + 宽限期回收 + 并发合并 + 失败缓存（不依赖 three，Node 可测） |
| `three-host.ts` | 纹理/网格装载、回退计数、加载器复用与销毁 |
| `loader-factory.ts` | **所有 three 加载器都在这里动态 `import()`** —— 这是解码器不进主包的实现点 |

## 三条约定

1. **`three` 只作为类型依赖**（`import type`）。任何运行时 `import three` 都会把加载器拉进主包。
2. **解码器由部署方托管**在 `public/decoders/`，用 `node tools/copy-decoders.mjs` 拷，带上 LICENSE。
3. **`fallbacks` 是线上最有用的数字**：它说明这台设备退化到了什么程度。

详见 [docs/ASSETS.md](../../docs/ASSETS.md)。

测试：`pnpm --filter @tabby/assets test`（33 项，纯 Node，不需要 WebGL）。
