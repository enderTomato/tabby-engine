/**
 * 地形数据类型定义。
 *
 * 约定（全模块统一，勿改）：
 * - 高度单位一律「米」，内部存储为 Uint16 量化值；
 * - 世界坐标 x 向东、y 向北、z 向上（与物理层保持一致，物理层用 Y 向上，渲染层负责转换）；
 * - 栅格行优先存储，**第 0 行是最北一行**，行号增大即向南（与 DEM/SRTM 习惯一致）；
 * - 垂直夸张只作用于渲染，不改变数据本身。
 */

/** 离线工具可解析的源格式。GeoTIFF 需先外部转成 PNG/ASC，理由见 docs/design/T07-terrain.md。 */
export type TerrainSourceFormat = 'png-8bit' | 'png-16bit' | 'srtm-hgt' | 'ascii-grid';

/** 投影方式。游戏内一律平面坐标，这里只记录原始数据的经纬度信息用于溯源。 */
export type TerrainProjection =
  | { readonly type: 'local'; readonly metersPerUnit: number }
  | {
      readonly type: 'equirect';
      /** [west, south, east, north]，单位度。 */
      readonly bbox: readonly [number, number, number, number];
    }
  | {
      readonly type: 'mercator';
      readonly bbox: readonly [number, number, number, number];
    };

export interface TerrainLicense {
  /** 数据源名称，如 "SRTM 1 Arc-Second Global"。 */
  readonly source: string;
  readonly url: string;
  /** 署名要求文本，UI 的「数据来源」必须原样展示。 */
  readonly attribution: string;
  /** 再分发限制；'public-domain' 表示无限制。 */
  readonly redistribution: 'public-domain' | 'attribution' | 'restricted';
}

/** 一级 LOD 的描述。LOD0 为原始分辨率。 */
export interface TerrainLodLevel {
  readonly level: number;
  /** 相对于 LOD0 的采样步长，1 表示原图，2 表示隔点取。 */
  readonly step: number;
  readonly width: number;
  readonly height: number;
  /** 相对路径，指向该级的 r16 大文件（非分块模式）。 */
  readonly file?: string;
}

export interface TerrainChunkLayout {
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksY: number;
  /** 分块文件路径模板，`{x}` `{y}` `{lod}` 会被替换。 */
  readonly pathTemplate: string;
}

/**
 * 产物元数据，随 .r16 一起发布，运行时唯一可信来源。
 * 版本号用于存档迁移：字段增删必须升 version 并提供迁移函数。
 */
export interface TerrainMeta {
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  /** 一个栅格单元代表的水平距离（米）。 */
  readonly cellSizeMeters: number;
  /** 最低/最高海拔（米），量化区间端点。 */
  readonly minElevation: number;
  readonly maxElevation: number;
  /** 海平面基准（米），用于判定水域与可建性。 */
  readonly seaLevel: number;
  /** 渲染垂直夸张系数，仅影响显示。 */
  readonly verticalScale: number;
  readonly projection: TerrainProjection;
  readonly license: TerrainLicense;
  readonly lods: readonly TerrainLodLevel[];
  readonly chunks: TerrainChunkLayout | null;
  /** 法线图相对路径（可选产物）。 */
  readonly normalFile: string | null;
  /** 流向图相对路径（可选产物，供液体模块复用）。 */
  readonly flowFile: string | null;
  /** 生成该产物的工具版本，便于定位数据问题。 */
  readonly generator: string;
  readonly generatedAt: string;
}

/** 单个分块。data 长度为 chunkSize²，边界块会被补齐。 */
export interface TerrainChunk {
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
  readonly data: Uint16Array;
}

/** 采样选项：影响越界行为。 */
export interface SampleOptions {
  /** 图外查询的返回值（米）。缺省为 minElevation。 */
  readonly outside?: number;
}

/** 量化/反量化的换算参数。 */
export interface ElevationRange {
  readonly minElevation: number;
  readonly maxElevation: number;
}
