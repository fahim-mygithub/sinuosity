import type { Route } from './types';

/**
 * Hand-picked real roads in Western NY. Coordinate paths are APPROXIMATE sketches
 * (good enough to identify the road and launch navigation), not snapped-to-road
 * polylines. Scenery/canopy/community values are author estimates, not measured.
 */
export const CURATED_ROUTES: Route[] = [
  {
    id: 'varysburg',
    name: 'US-20A East (Varysburg Ridge)',
    type: 'High-altitude sweeper',
    highlights: 'Valley plunges, deep ridge sweeps',
    sinuosity: 8.5,
    scenery: 9.2,
    canopy: 75,
    waterProximity: 'Tonawanda Creek valley',
    community: 9.0,
    communityIntel:
      'Locals rate the Varysburg hill drop highly for its open valley views — watch for farm equipment.',
    note: 'Big elevation change as US-20A drops into the Tonawanda valley. Open sweepers, strong vistas, less tree cover than the southern routes.',
    color: '#ef4444',
    coords: [
      [42.7684, -78.6143], [42.765, -78.592], [42.772, -78.568], [42.751, -78.542],
      [42.744, -78.512], [42.753, -78.471], [42.748, -78.432], [42.739, -78.391], [42.754, -78.326],
    ],
    pins: [
      { lat: 42.751, lon: -78.542, type: 'lookout', title: 'Tonawanda Valley overlook', desc: 'Pull-off with a wide view across the ridge system.' },
      { lat: 42.744, lon: -78.512, type: 'caution', title: 'Deer crossing', desc: 'Wooded ridge base — higher deer risk near dusk.' },
    ],
  },
  {
    id: 'cazenovia',
    name: 'NY-240 South (Colden Valley)',
    type: 'Technical valley-carver',
    highlights: 'Rhythmic twists along Cazenovia Creek',
    sinuosity: 9.1,
    scenery: 8.8,
    canopy: 95,
    waterProximity: 'Hugs Cazenovia Creek',
    community: 9.3,
    communityIntel:
      'Riders describe a near-complete summer tree tunnel through Colden — keep speed sensible near the center.',
    note: 'One of the closest genuinely twisty roads to home. Follows the creek south through Colden under heavy summer canopy.',
    color: '#f97316',
    coords: [
      [42.748, -78.742], [42.731, -78.729], [42.715, -78.718], [42.692, -78.701],
      [42.668, -78.688], [42.645, -78.674], [42.621, -78.653], [42.592, -78.641], [42.564, -78.632],
    ],
    pins: [
      { lat: 42.692, lon: -78.701, type: 'scenic', title: 'Creek bed viewpoint', desc: 'Clear view of shallow creek ripples and slate shelves.' },
    ],
  },
  {
    id: 'zoar',
    name: 'Zoar Valley Road (Gorge Loop)',
    type: 'Tight hairpin corridor',
    highlights: 'Shale cliffs, dense woods, steep hollows',
    sinuosity: 9.5,
    scenery: 9.7,
    canopy: 98,
    waterProximity: 'Cattaraugus Creek gorge',
    community: 9.6,
    communityIntel:
      'Hikers and riders both single out the sheer shale gorge walls and heavy foliage as the standout scenery in the region.',
    note: 'The most dramatic scenery near Buffalo — sheer shale walls along the Cattaraugus gorge, tight and shaded. Roughly an hour south.',
    color: '#e11d48',
    coords: [
      [42.451, -78.96], [42.441, -78.941], [42.446, -78.918], [42.435, -78.895],
      [42.449, -78.872], [42.459, -78.848],
    ],
    pins: [
      { lat: 42.446, lon: -78.918, type: 'lookout', title: 'Zoar gorge brink', desc: 'Lookout down into the Cattaraugus canyon.' },
    ],
  },
  {
    id: 'niagara',
    name: 'Niagara Scenic Parkway (North Gorge)',
    type: 'Overlook cruise',
    highlights: 'Canyon views into the Niagara River',
    sinuosity: 4.5,
    scenery: 9.8,
    canopy: 30,
    waterProximity: 'Niagara River canyon edge',
    community: 8.8,
    communityIntel:
      'Popular evening cruise toward Lewiston, where the sun sets over the Canadian bank.',
    note: "Not twisty — this one's for the views. Runs the rim of the Niagara gorge toward Lewiston; best near sunset.",
    color: '#10b981',
    coords: [
      [43.082, -79.06], [43.101, -79.058], [43.125, -79.051], [43.149, -79.038],
      [43.178, -79.043], [43.21, -79.049], [43.25, -79.044],
    ],
    pins: [
      { lat: 43.149, lon: -79.038, type: 'lookout', title: 'Niagara gorge overlook', desc: 'View down into the river rapids.' },
    ],
  },
  {
    id: 'lakeontario',
    name: 'Lake Ontario Byway (Route 18)',
    type: 'Water-horizon sweeper',
    highlights: 'Open lake views, continuous horizon',
    sinuosity: 3.8,
    scenery: 9.5,
    canopy: 15,
    waterProximity: 'Runs along Lake Ontario shoreline',
    community: 9.2,
    communityIntel: 'Riders point to Olcott Beach for golden-hour light over the open water.',
    note: "Flat and straight, but the payoff is an uninterrupted lake horizon. Golden hour at Olcott is the highlight.",
    color: '#06b6d4',
    coords: [
      [43.342, -78.98], [43.345, -78.9], [43.343, -78.82], [43.348, -78.74],
      [43.344, -78.66], [43.351, -78.58],
    ],
    pins: [
      { lat: 43.348, lon: -78.74, type: 'scenic', title: 'Olcott Beach harbor', desc: 'Historic harbor with sunsets over the lake.' },
    ],
  },
];
