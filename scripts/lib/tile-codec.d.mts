// Types for the build-time codec twin, so src/lib/tileCodec.test.ts can import it under `tsc`
// without falling back to `any` — the parity test is worthless if TypeScript cannot see the shapes
// it is comparing.

export declare const QUANT: number;
export declare const TILE_DEG: number;
export declare const MARGIN_KM: number;
export declare function encodePath(coords: [number, number][]): number[];
export declare function decodePath(enc: number[]): [number, number][];
export declare function tileIndex(lat: number, lon: number): [number, number];
export declare function tileKey(latIdx: number, lonIdx: number): string;
export declare function tileBounds(latIdx: number, lonIdx: number): [number, number, number, number];
