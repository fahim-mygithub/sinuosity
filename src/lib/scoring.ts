import type { Route, ScoredRoute, Weights } from '../data/types';

/**
 * Composite score for a curated route. Twistiness is the only measured input;
 * scenery and community are author estimates (flagged as such in the UI).
 * Seasonal modifier is a crude heuristic, not a real foliage/satellite signal.
 */
export function scoreRoute(route: Route, w: Weights): number {
  let seasonalModifier = 0;
  if (route.canopy > 70) seasonalModifier += 4; // summer shade bonus (heuristic)
  if (route.canopy < 40) seasonalModifier += 6; // open sky / sunset bonus (heuristic)

  const weighted =
    (route.sinuosity * w.sinuosity +
      route.scenery * w.scenery +
      route.community * w.community) /
    (w.sinuosity + w.scenery + w.community);

  return Math.min(100, Math.round(weighted * 10 + seasonalModifier));
}

export function scoreAndSort(routes: Route[], w: Weights): ScoredRoute[] {
  return routes
    .map((r) => ({ ...r, score: scoreRoute(r, w) }))
    .sort((a, b) => b.score - a.score);
}
