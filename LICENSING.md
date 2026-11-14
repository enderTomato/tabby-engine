# 许可

本项目采用**分层许可**：核心引擎与示例代码的授权条款不同。

| 范围 | 许可 | 原因 |
|---|---|---|
| `packages/physics`、`packages/core`、`packages/platform`、`packages/worker`、`packages/terrain`、`packages/economy`、`packages/graph` | **MPL-2.0** | 文件级 copyleft：修改了这几个包里的文件必须把改动以 MPL 公开，但不影响链接它的商业闭源代码 |
| `packages/render2d`、`packages/render3d`、`packages/engine`、`packages/animation` | **MPL-2.0** | 同上 |
| `apps/demo`、`examples/`、文档与配图 | **MIT** | 示例应当可以随便抄进任何项目，包括闭源商业项目 |

## 为什么核心选 MPL-2.0 而不是 Apache-2.0

这两个都是「商业友好」许可，差别在**回馈义务**：

- **Apache-2.0**：宽松。任何人都可以把代码拿去改、闭源、卖，不需要回馈任何东西，只保留版权声明与 NOTICE。附带的专利授权是它相对 MIT 的优势。
- **MPL-2.0**：文件级 copyleft。你可以把它链接进闭源产品并销售（这点和 Apache-2.0 一样），但**如果你修改了 MPL 覆盖的文件本身**，必须把那些修改后的文件以 MPL 公开。新增文件不受影响，可以是闭源的。

本项目要做的是「半开源物理引擎」，核心诉求是**让引擎本身的改进回流**，而不是阻止别人拿去做商业游戏。MPL-2.0 正好落在这个点上：

- 拿去做游戏、改上层玩法 → 完全自由，不用开源你的游戏；
- 改了 `fluid.ts` 的求解器想偷偷不发出来 → 不允许；
- 专利授权条款与 Apache-2.0 相当，不用另写 CLA。

Apache-2.0 会出现「有人 fork 一份改进版闭源卖」，这与「半开源」的定位相悖。GPL/LGPL 则过重：LGPL 的动态链接要求在前端 bundle 场景下解释不清，容易把用引擎的人吓走。

## 第三方依赖

| 依赖 | 许可 | 用途 |
|---|---|---|
| three | MIT | 3D 渲染适配层（不在物理包内） |
| pixi.js | MIT | 2D 渲染适配层 |
| vue | MIT | demo 与 UI |
| gsap | 标准「免版税」许可（非 OSI） | 动画时间轴，仅 demo 与 `animation` 包使用 |

**注意 GSAP**：它的许可是「GreenSock Standard License」，允许免费商用但禁止把 GSAP 本身当作产品出售。本项目的 `packages/animation` 只是把它当可选依赖封装，没有分发其源码；如果你要分发包含 GSAP 的构建产物，请自行确认合规。

## 数据许可

`packages/terrain` 只处理用户自行提供的高程数据，不附带任何 DEM 数据。使用时请注意数据源条款：

- **SRTM**：美国政府作品，公有领域，可自由使用。
- **Copernicus DEM**：需署名 `© ESA / Copernicus`。
- **ASTER GDEM**：需署名 `NASA/METI`，且不得转售原始数据。

详见 `packages/terrain/README.md`。
