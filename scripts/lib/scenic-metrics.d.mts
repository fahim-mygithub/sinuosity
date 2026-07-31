// Partial types for the build-time metrics lib — just the functions whose output gets BAKED into
// tiles and must therefore agree with src/lib/geometry.ts. See the parity test in tileCodec.test.ts.

export declare function sinuosityScore(coords: [number, number][]): number;
export declare function flowCurvature(coords: [number, number][]): number;
export declare function pathLengthKm(coords: [number, number][]): number;
export declare function haversineKm(a: [number, number], b: [number, number]): number;
export declare function haversineM(a: [number, number], b: [number, number]): number;
