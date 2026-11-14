<!-- 公开 API 快照。不要手改，用 node scripts/api-snapshot.mjs --update 更新。 -->
<!-- hash: 135d28d4242de5fb -->

## @tabby/physics
export type { Vec3Like, PhysicsBounds, Obstacle, FluidOptions, FluidStats, PhysicsStats, RagdollOptions, SmokeOptions, };
export { FluidSolver } from '../fluid.js';
export { LiquidSystem, DEFAULT_LIQUID, type LiquidOptions, type LiquidSource, type LiquidOverflow, } from '../liquid.js';
export { Ragdoll } from '../ragdoll.js';
export { Pendulum, type PendulumConfig } from '../pendulum.js';
export { DoublePendulum, type DoublePendulumConfig } from '../pendulum-chain.js';
export { SmokeSystem, SMOKE_STRIDE } from '../smoke.js';
export { WindField, DEFAULT_WIND, WIND_STRIDE, type WindConfig } from '../wind.js';
export { ObstacleGrid } from '../spatial-hash.js';
export { PhysicsWorld, DEFAULT_BOUNDS, type PhysicsWorldOptions } from '../world.js';

## @tabby/physics/extension
import type { PhysicsBounds } from '../types.js';
import type { Ragdoll } from '../ragdoll.js';
export interface BodyWakeEvent {
readonly ragdollId: string;
}
export interface CollisionEvent {
readonly ragdollId: string;
readonly pointIndex: number;
readonly obstacleId: string | null;
readonly face: number;
}
export interface LiquidOverflowEvent {
readonly cellIndex: number;
readonly height: number;
readonly volume: number;
}
export interface StepEvent {
readonly dt: number;
readonly ms: number;
readonly sleepingRagdolls: number;
}
export interface PluginErrorEvent {
readonly plugin: string;
readonly hook: string;
readonly error: unknown;
}
export interface EventsDroppedEvent {
readonly count: number;
}
export interface PhysicsEventMap {
readonly bodySleep: BodySleepEvent;
readonly bodyWake: BodyWakeEvent;
readonly collision: CollisionEvent;
readonly liquidOverflow: LiquidOverflowEvent;
readonly step: StepEvent;
readonly pluginError: PluginErrorEvent;
readonly eventsDropped: EventsDroppedEvent;
}
export type EventHandler<T> = (event: T) => void;
export declare class PhysicsEventBus {
private readonly handlers;
private readonly sampledCount;
private dropped;
on<K extends keyof PhysicsEventMap>(type: K, handler: EventHandler<PhysicsEventMap[K]>): () => void;
once<K extends keyof PhysicsEventMap>(type: K, handler: EventHandler<PhysicsEventMap[K]>): () => void;
off<K extends keyof PhysicsEventMap>(type: K, handler: EventHandler<PhysicsEventMap[K]>): void;
emit<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K]): void;
emitSampled<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K], budget?: number): void;
resetSampling(): number;
listenerCount(type: keyof PhysicsEventMap): number;
clear(): void;
}
export interface ForceContext {
readonly bounds: PhysicsBounds;
readonly time: number;
readonly ragdolls: readonly Ragdoll[];
}
export interface ForceField {
readonly id: string;
apply(ctx: ForceContext, dt: number): void;
dispose?(): void;
}
export interface ConstraintContext {
readonly bounds: PhysicsBounds;
readonly time: number;
readonly ragdolls: readonly Ragdoll[];
}
export interface CustomConstraint {
readonly id: string;
solve(ctx: ConstraintContext): void;
dispose?(): void;
}
export interface RegistryOptions {
readonly onDuplicate?: 'replace' | 'ignore' | 'error';
}
export declare class ForceFieldRegistry {
private readonly fields;
private readonly priorities;
private readonly options;
constructor(options?: RegistryOptions);
get size(): number;
add(field: ForceField, priority?: number): void;
remove(id: string): boolean;
clear(): void;
apply(ctx: ForceContext, dt: number): void;
list(): readonly string[];
}
export declare class ConstraintRegistry {
private readonly constraints;
private readonly options;
constructor(options?: RegistryOptions);
get size(): number;
add(constraint: CustomConstraint, priority?: number): void;
remove(id: string): boolean;
clear(): void;
solve(ctx: ConstraintContext): void;
list(): readonly string[];
}
export interface PluginWorldView {
readonly bounds: PhysicsBounds;
readonly time: number;
readonly ragdolls: readonly Ragdoll[];
readonly events: PhysicsEventBus;
readonly forces: ForceFieldRegistry;
readonly constraints: ConstraintRegistry;
}
export interface PhysicsPlugin {
readonly name: string;
register(world: PluginWorldView): void;
onBeforeStep?(world: PluginWorldView, dt: number): void;
onAfterStep?(world: PluginWorldView, dt: number): void;
dispose?(): void;
}
export declare class PluginHost {
private readonly plugins;
private readonly bus;
constructor(bus: PhysicsEventBus);
get names(): readonly string[];
add(plugin: PhysicsPlugin, view: PluginWorldView): void;
remove(name: string): boolean;
beforeStep(view: PluginWorldView, dt: number): void;
afterStep(view: PluginWorldView, dt: number): void;
disposeAll(): void;
private report;
}

## @tabby/physics/presets
import type { CustomConstraint, ForceField } from './extension.js';
import { WindField } from '../wind.js';
export interface WindForceOptions {
readonly strength?: number;
readonly wakeSleeping?: boolean;
}
export declare function createWindForce(id: string, wind: WindField, options?: WindForceOptions): ForceField;
export interface ExplosionOptions {
readonly x: number;
readonly y: number;
readonly z: number;
readonly radius: number;
readonly power: number;
readonly once?: boolean;
}
export declare function createExplosionForce(id: string, options: ExplosionOptions): ForceField;
export declare function createLeashConstraint(id: string, ragdollId: string, pointIndex: number, anchor: {
readonly x: number;
readonly y: number;
readonly z: number;
}, maxDistance: number): CustomConstraint;
