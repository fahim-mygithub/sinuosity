// User-adjustable composite scoring for scenic rides. The build pipeline bakes a
// deterministic 0-100 score from each route's 0-10 rubric (see scripts/lib/scenic-metrics.mjs);
// this module is the in-app mirror that lets a rider re-weight the same rubric on the fly —
// "I only care about twisties", "show me the waterside roads" — without re-running the build.
// With the default weights it reproduces the .mjs compositeScore exactly.

import type { ScenicRubric } from '../data/types'

/**
 * The bias knobs, one per rubric dimension. Need not sum to 1 — see normalizeWeights.
 * `gradeDrama` (elevation) is optional so existing 5-field weight literals still satisfy the type;
 * a missing knob counts as 0.
 */
export interface BiasWeights {
  curvature: number
  scenery: number
  greenery: number
  water: number
  notability: number
  gradeDrama?: number
}

/**
 * Motorcycle-audience default composite weights. Curvature is the headline term. `gradeDrama` is 0
 * here so this stays the numeric mirror of COMPOSITE_WEIGHTS in scripts/lib/scenic-metrics.mjs
 * (the baked scenic/curated datasets carry no elevation): with gradeDrama 0 the composite is
 * byte-identical to the 5-field build pipeline. The Scan tab opts into elevation via BIAS_PRESETS.
 */
export const COMPOSITE_WEIGHTS: BiasWeights = {
  curvature: 0.35,
  scenery: 0.2,
  greenery: 0.15,
  water: 0.15,
  notability: 0.15,
  gradeDrama: 0,
}

const KEYS: (keyof BiasWeights)[] = ['curvature', 'scenery', 'greenery', 'water', 'notability', 'gradeDrama']

/**
 * Scale the five weights so they sum to 1. Negatives are clamped to 0 first; if the resulting
 * sum is 0 (all-zero or all-negative input) the safe default COMPOSITE_WEIGHTS is returned.
 */
export function normalizeWeights(raw: BiasWeights): BiasWeights {
  const clamped = KEYS.map((k) => Math.max(0, raw[k] ?? 0))
  const sum = clamped.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return { ...COMPOSITE_WEIGHTS }
  const out = {} as BiasWeights
  KEYS.forEach((k, i) => {
    out[k] = clamped[i] / sum
  })
  return out
}

/**
 * Deterministic 0-100 composite from a 0-10 rubric under the given bias. Weights are normalized
 * internally, so any positive set works. With the default weights and a rubric this matches the
 * build pipeline's compositeScore (Math.round(weightedAvg * 10)). Missing fields count as 0.
 */
export function compositeScore(rubric: ScenicRubric, weights: BiasWeights = COMPOSITE_WEIGHTS): number {
  const w = normalizeWeights(weights)
  const avg =
    w.curvature * (rubric.curvature ?? 0) +
    w.scenery * (rubric.scenery ?? 0) +
    w.greenery * (rubric.greenery ?? 0) +
    w.water * (rubric.water ?? 0) +
    w.notability * (rubric.notability ?? 0) +
    (w.gradeDrama ?? 0) * (rubric.gradeDrama ?? 0)
  return Math.round(avg * 10)
}

/** A one-tap rider-facing weighting preset. */
export interface BiasPreset {
  id: string
  label: string
  hint: string
  weights: BiasWeights
}

/**
 * Selectable bias presets for the Live scan. compositeScore normalizes regardless, so each set
 * here keeps its original 5-dimension RATIOS and simply adds a `gradeDrama` (elevation) knob on
 * top — normalization rescales the whole thing back to sum 1. Balanced and Twisty weight elevation
 * most (a climbing road complements corners); Waterside/Notable keep it light. This is where the
 * Scan opts into elevation; the baked datasets keep the 5-field {@link COMPOSITE_WEIGHTS}.
 */
export const BIAS_PRESETS: BiasPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Our default blend — twisties and elevation first, then the scenery around them.',
    weights: { curvature: 0.35, scenery: 0.2, greenery: 0.15, water: 0.15, notability: 0.15, gradeDrama: 0.15 },
  },
  {
    id: 'twisty',
    label: 'Twisty',
    hint: 'All about the corners and the climbs. Ranks the tightest, hilliest roads to the top.',
    weights: { curvature: 0.6, scenery: 0.1, greenery: 0.1, water: 0.1, notability: 0.1, gradeDrama: 0.18 },
  },
  {
    id: 'scenic',
    label: 'Scenic',
    hint: 'Big views and green corridors — the rides you slow down for.',
    weights: { curvature: 0.2, scenery: 0.4, greenery: 0.25, water: 0.1, notability: 0.05, gradeDrama: 0.12 },
  },
  {
    id: 'waterside',
    label: 'Waterside',
    hint: 'Lakes, rivers and shoreline — roads that hug the water.',
    weights: { curvature: 0.2, scenery: 0.15, greenery: 0.1, water: 0.5, notability: 0.05, gradeDrama: 0.05 },
  },
  {
    id: 'notable',
    label: 'Notable',
    hint: 'Landmarks and points of interest — rides with something to stop for.',
    weights: { curvature: 0.2, scenery: 0.15, greenery: 0.1, water: 0.05, notability: 0.5, gradeDrama: 0.05 },
  },
]
