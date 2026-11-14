/**
 * 经纬度 → 米制局部平面。
 *
 * ## 为什么运行时只见米
 *
 * 模拟经营的商品流、寻路、碰撞、经济结算全是米制平面运算。把经纬度带到运行时，
 * 每算一次距离就要做球面几何，而且单位不统一（x 方向 1° 和 z 方向 1° 长度不同），
 * 迟早出「南北向的路比东西向的同样长度更短」这种 bug。
 * 所以投影只在离线预处理做一次，运行时只见米（与 HeightField 的约定一致）。
 *
 * ## 两种近似与误差
 *
 * **等距圆柱（equirectangular）**：
 *
 *     x = (lon - lon0) · 111320 · cos(lat0)
 *     z = (lat0 - lat) · 111320
 *
 * 以 bbox 中心纬度做一次缩放。误差来自「同一张图里纬度跨度过大」——
 * 在 50 km 尺度上，纬度每变化 1°，cos 变化约 0.017%，对 50 km 图约 8 米误差。
 * 城市级（≤ 50 km）可以接受。
 *
 * **墨卡托（mercator）**：
 * 保角、正方形网格，适合视觉上「不变形」，但面积随纬度放大，
 * 高纬度地图向北会明显拉伸。60° 纬线处放大 2 倍。
 *
 * 选择原则：地形只用于视觉与碰撞 → 用等距圆柱（简单、够准）；
 * 需要和真实地图对齐（GPS 定位、真实路网叠图）→ 用墨卡托。
 */

export type GeoProjection = 'equirect' | 'mercator';

/** 每度纬度对应的米数（WGS84 平均值）。 */
const METERS_PER_DEGREE = 111320;

export interface GeoBBox {
  /** [west, south, east, north]，单位度。 */
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface GeoTransform {
  readonly projection: GeoProjection;
  readonly bbox: GeoBBox;
  /** 该 bbox 在米制下的宽高。 */
  readonly widthMeters: number;
  readonly heightMeters: number;
  /** 经纬度 → 局部米制坐标（原点在 bbox 西北角，x 向东、z 向南）。 */
  toLocal(lon: number, lat: number): { readonly x: number; readonly z: number };
  /** 局部米制坐标 → 经纬度。 */
  toGeo(x: number, z: number): { readonly lon: number; readonly lat: number };
}

export function createGeoTransform(bbox: GeoBBox, projection: GeoProjection = 'equirect'): GeoTransform {
  if (!(bbox.east > bbox.west) || !(bbox.north > bbox.south)) {
    throw new Error(`[tabby/terrain] bbox 非法：[${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}]`);
  }

  const latSpan = bbox.north - bbox.south;
  const lonSpan = bbox.east - bbox.west;

  if (projection === 'mercator') {
    const ySouth = mercatorY(bbox.south);
    const yNorth = mercatorY(bbox.north);
    const heightMeters = (yNorth - ySouth) * METERS_PER_DEGREE;
    // 墨卡托在赤道处 x 缩放为 1，这里用中央经线所在纬度的 cos 作为水平缩放，
    // 保证 bbox 中心不拉伸；两侧会有轻微放大，是墨卡托的固有性质
    const centerLat = (bbox.south + bbox.north) / 2;
    const widthMeters = lonSpan * METERS_PER_DEGREE * Math.cos((centerLat * Math.PI) / 180);

    return {
      projection,
      bbox,
      widthMeters,
      heightMeters,
      toLocal(lon, lat) {
        const x = ((lon - bbox.west) / lonSpan) * widthMeters;
        const y = (mercatorY(lat) - ySouth) * METERS_PER_DEGREE;
        return { x, z: heightMeters - y };
      },
      toGeo(x, z) {
        const y = ySouth + (heightMeters - z) / METERS_PER_DEGREE;
        return { lon: bbox.west + (x / widthMeters) * lonSpan, lat: invMercatorY(y) };
      },
    };
  }

  const centerLat = (bbox.south + bbox.north) / 2;
  const scaleX = METERS_PER_DEGREE * Math.cos((centerLat * Math.PI) / 180);
  const widthMeters = lonSpan * scaleX;
  const heightMeters = latSpan * METERS_PER_DEGREE;

  return {
    projection,
    bbox,
    widthMeters,
    heightMeters,
    toLocal(lon, lat) {
      return { x: (lon - bbox.west) * scaleX, z: (bbox.north - lat) * METERS_PER_DEGREE };
    },
    toGeo(x, z) {
      return { lon: bbox.west + x / scaleX, lat: bbox.north - z / METERS_PER_DEGREE };
    },
  };
}

/** 墨卡托 y（弧度制单位球展开后乘以 111320 就是米）。 */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

function invMercatorY(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/**
 * 给 SRTM 的 1°×1° 瓦片算 bbox。
 *
 * SRTM 文件名形如 `N39E116.hgt`，其中 N39E116 表示**西南角**坐标。
 * 这个函数就是为了把文件名转成 bbox，避免手工拼错南北半球。
 */
export function srtmTileBBox(name: string): GeoBBox {
  const match = /^([NS])(\d{2})([EW])(\d{3})$/i.exec(name.trim());
  if (match === null) {
    throw new Error(`[tabby/terrain] 无法解析 SRTM 瓦片名：${name}（期望形如 N39E116）`);
  }
  const ns = (match[1] as string).toUpperCase();
  const ew = (match[3] as string).toUpperCase();
  const lat = Number(match[2]) * (ns === 'S' ? -1 : 1);
  const lon = Number(match[4]) * (ew === 'W' ? -1 : 1);
  return { west: lon, south: lat, east: lon + 1, north: lat + 1 };
}
