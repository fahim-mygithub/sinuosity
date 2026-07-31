// Types for the build-time categorizer twin. Mirrors src/lib/features.ts FeatureCatalog so the
// parity test in src/lib/features.test.ts is checked, not silently `any`-compared.

import type { OverpassElement } from '../../src/lib/overpass';
import type { FeatureCatalog } from '../../src/lib/features';

export declare function categorizeFeatures(elements: OverpassElement[]): FeatureCatalog;
