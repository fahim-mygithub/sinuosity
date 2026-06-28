import type { ScenicRubric } from '../data/types';

/** The five BAKED rubric dimensions this build-time mirror scores (no elevation — see below). */
type BakedWeights = Record<'curvature' | 'scenery' | 'greenery' | 'water' | 'notability', number>;

/**
 * Motorcycle-audience composite weights (sum to 1). Curvature is the headline term —
 * this is a twisty-road finder, so a route's measured twistiness dominates the ranking
 * rather than the famous-water/notability bias the old LLM score had.
 *
 * Mirror of COMPOSITE_WEIGHTS in scripts/lib/scenic-metrics.mjs; the dataset is built by
 * the script and re-verified against this module in the metrics test, so the two cannot drift.
 * The baked scenic/curated datasets are 2D, so this mirror is deliberately the FIVE-dimension
 * set (no `gradeDrama`); the runtime Scan adds elevation via composite.ts, which keeps baked
 * scores byte-identical.
 */
export const COMPOSITE_WEIGHTS: BakedWeights = {
  curvature: 0.35,
  scenery: 0.2,
  greenery: 0.15,
  water: 0.15,
  notability: 0.15,
};

/** Deterministic 0–100 composite from a 0–10 rubric. Reproducible — replaces the LLM score. */
export function compositeScore(rubric: ScenicRubric, weights: BakedWeights = COMPOSITE_WEIGHTS): number {
  const avg =
    weights.curvature * rubric.curvature +
    weights.scenery * rubric.scenery +
    weights.greenery * rubric.greenery +
    weights.water * rubric.water +
    weights.notability * rubric.notability;
  return Math.round(avg * 10);
}
