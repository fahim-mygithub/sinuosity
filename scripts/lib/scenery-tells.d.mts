// Types for the build-time scenery lib, so the baked-vs-runtime rubric parity test in
// src/lib/sceneryTells.test.ts is actually type-checked instead of silently `any`-compared.

import type { LatLng } from '../../src/lib/geometry';
import type { RubricTells, MeasuredScenery } from '../../src/lib/sceneryTells';

export declare const TAU: { water: number; green: number; view: number; peak: number; ugly: number };
export declare const ADJ_M: number;
export declare function sampleRoute(coords: LatLng[], max?: number): LatLng[];
export declare function pointInRing(pt: LatLng, ring: LatLng[]): boolean;
export declare function fractionInside(routePts: LatLng[], polygons: LatLng[][]): number;
export declare function corridorSignal(
  routePts: LatLng[], tellPts: LatLng[], tauM: number, adjM?: number,
): { adj: number; prox: number; minM: number };
export declare function weightedSignal(
  routePts: LatLng[], weightedTells: { pt: LatLng; w: number }[], tauM: number,
): { prox: number; adj: number };
export declare function measureRubric(coords: LatLng[], tells: Partial<RubricTells>): MeasuredScenery;
