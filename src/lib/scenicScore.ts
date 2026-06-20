import type { ScenicRubric } from '../data/types';

/**
 * Motorcycle-audience composite weights (sum to 1). Curvature is the headline term —
 * this is a twisty-road finder, so a route's measured twistiness dominates the ranking
 * rather than the famous-water/notability bias the old LLM score had.
 *
 * Mirror of COMPOSITE_WEIGHTS in scripts/lib/scenic-metrics.mjs; the dataset is built by
 * the script and re-verified against this module in the metrics test, so the two cannot drift.
 */
export const COMPOSITE_WEIGHTS: Record<keyof ScenicRubric, number> = {
  curvature: 0.35,
  scenery: 0.2,
  greenery: 0.15,
  water: 0.15,
  notability: 0.15,
};

/** Deterministic 0–100 composite from a 0–10 rubric. Reproducible — replaces the LLM score. */
export function compositeScore(rubric: ScenicRubric, weights = COMPOSITE_WEIGHTS): number {
  const avg =
    weights.curvature * rubric.curvature +
    weights.scenery * rubric.scenery +
    weights.greenery * rubric.greenery +
    weights.water * rubric.water +
    weights.notability * rubric.notability;
  return Math.round(avg * 10);
}
