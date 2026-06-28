import type { ScenicStop, ScenicRubric } from '../data/types';

/** Emoji per scenic-stop kind. Single source shared by the map popups and the review. */
export const KIND_ICON: Record<ScenicStop['kind'], string> = {
  viewpoint: '🌄', waterfall: '💦', gorge: '🪨', water: '💧', overlook: '🔭',
  village: '🏘️', forest: '🌲', bridge: '🌉', caution: '⚠️',
};

/** Rubric rows in display order. `gradeDrama` (Elevation) is only measured by the Live scan, so it
 *  renders only when present (the baked datasets omit it — see RubricMeters). */
export const RUBRIC_LABELS: { key: keyof ScenicRubric; label: string }[] = [
  { key: 'curvature', label: 'Twisties' },
  { key: 'gradeDrama', label: 'Elevation' },
  { key: 'scenery', label: 'Scenery' },
  { key: 'greenery', label: 'Greenery' },
  { key: 'water', label: 'Water' },
  { key: 'notability', label: 'Notable' },
];
