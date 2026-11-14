import type { Aabb3, Vec2, Vec3 } from './types.js';

export const TWO_PI = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * (3 - 2 * t);
}

/** 与帧率无关的指数衰减插值：lambda 越大收敛越快。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function vec2Length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function vec3Length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function aabb3Contains(box: Aabb3, point: Vec3, padding = 0): boolean {
  return (
    point.x >= box.min.x - padding &&
    point.x <= box.max.x + padding &&
    point.y >= box.min.y - padding &&
    point.y <= box.max.y + padding &&
    point.z >= box.min.z - padding &&
    point.z <= box.max.z + padding
  );
}

export function makeAabb3(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Aabb3 {
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

/** 四舍五入到指定小数位，用于诊断输出而非物理计算。 */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
