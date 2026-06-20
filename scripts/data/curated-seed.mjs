// Hand-picked "Curated" WNY ride corridors — the editorial classics, distinct from the
// algorithmically-generated Scenic slate. This seed is the human input; the build script
// (scripts/curate-routes.mjs) upgrades each entry to full scenic quality: it OSRM-snaps the
// waypoints to real road geometry, MEASURES curvature from that geometry, snaps every stop to
// its nearest Street View pano (so the images actually render), and writes a transparent
// composite score. Curvature in the rubric below is a placeholder — it is overwritten with the
// measured value at build time. scenery/greenery/water/notability are editorial estimates.
//
// waypoints: [lat, lon] sketch points along the intended road (OSRM snaps the real line).
// stops:     [lat, lon] roughly at the scenic feature; the snapper moves each to the nearest
//            drivable pano and re-aims `heading` toward the feature if it moves appreciably.

export const CURATED_SEED = [
  {
    id: 'varysburg-20a-ridge',
    name: 'US-20A Varysburg Ridge Drop',
    theme: 'High-ridge valley-drop sweeper',
    region: 'US-20A, Varysburg to Warsaw, Wyoming County, WNY',
    color: '#ef4444',
    summary:
      "US-20A's signature ride: crest the Varysburg hill on the open ridge and let the road pour " +
      'east in long, high-speed sweepers down into the Tonawanda Creek valley, then roll the dairy-' +
      'farm uplands toward Warsaw. This is a big-vista sweeper, not a tight carver — the payoff is ' +
      'the elevation change and the open farm-and-forest skylines, with far less tree cover than the ' +
      'southern gorge routes. Watch for slow farm equipment and dusk deer along the wooded valley base.',
    whyRide:
      'Crest the Varysburg hill and ride US-20A down a long ridge sweep into the Tonawanda Valley — ' +
      'wide-open farm-and-forest vistas the whole way down.',
    rubric: { curvature: 7, scenery: 8, greenery: 6, water: 4, notability: 6 },
    waypoints: [
      [42.7684, -78.6143], [42.765, -78.592], [42.772, -78.568], [42.751, -78.542],
      [42.744, -78.512], [42.753, -78.471], [42.748, -78.432], [42.739, -78.391], [42.754, -78.326],
    ],
    stops: [
      { lat: 42.7684, lon: -78.6143, title: 'Varysburg Hill Crest', blurb: "Start up on the open ridge where US-20A tips over the Varysburg hill — the valley falls away to the east and the road unspools downhill in front of you. Big-sky farm country, the classic opening shot of the ride.", kind: 'overlook', heading: 95 },
      { lat: 42.751, lon: -78.542, title: 'Tonawanda Valley Overlook', blurb: 'A roadside pull-off with a wide view across the Tonawanda Creek valley and the ridge system beyond — patchwork dairy fields and woodlots stacking to the horizon as the sweepers bottom out.', kind: 'viewpoint', heading: 110 },
      { lat: 42.748, lon: -78.432, title: 'Sheldon Ridge Farmland', blurb: 'Rolling high-farm sweepers east of Sheldon: open hayfields and barns on both shoulders, the road rising and falling over the upland with long sightlines through the curves.', kind: 'viewpoint', heading: 90 },
      { lat: 42.754, lon: -78.326, title: 'Warsaw Valley Descent', blurb: 'The eastern finale, dropping toward the Oatka Creek valley and Warsaw — wooded grade changes giving way to the village in the hollow below.', kind: 'village', heading: 80 },
    ],
  },
  {
    id: 'colden-240-tree-tunnel',
    name: 'NY-240 Colden Creek Tree Tunnel',
    theme: 'Creek-hugging tree-tunnel carver',
    region: 'NY-240, West Falls to Glenwood, Erie County, WNY',
    color: '#f97316',
    summary:
      'One of the closest genuinely twisty roads to Buffalo. NY-240 follows the West Branch Cazenovia ' +
      'Creek south through Colden under a near-continuous summer hardwood canopy — a shaded green ' +
      'tunnel with the wooded valley walls rising on both sides and the creek riffling alongside the ' +
      'pavement. Rhythmic, low-stress bends rather than hairpins; ride it slow through the hamlet and ' +
      'enjoy the shade and the water on your right.',
    whyRide:
      'A shaded, creek-hugging carve down NY-240 through Colden — a summer green tunnel with the ' +
      'Cazenovia Creek riffling right beside the pavement.',
    rubric: { curvature: 7, scenery: 6, greenery: 9, water: 6, notability: 4 },
    waypoints: [
      [42.748, -78.742], [42.731, -78.729], [42.715, -78.718], [42.692, -78.701],
      [42.668, -78.688], [42.645, -78.674], [42.621, -78.653], [42.592, -78.641], [42.564, -78.632],
    ],
    stops: [
      { lat: 42.715, lon: -78.718, title: 'Canopy Gateway near West Falls', blurb: 'Where NY-240 narrows and the hardwood canopy closes overhead — the start of the green tunnel, the valley walls funneling you south toward Colden.', kind: 'forest', heading: 190 },
      { lat: 42.692, lon: -78.701, title: 'Cazenovia Creek Bend', blurb: 'A clear roadside look at the West Branch Cazenovia Creek running shallow over slate shelves, overhanging maples shading the water — the creek-hugging heart of the ride.', kind: 'water', heading: 165 },
      { lat: 42.645, lon: -78.674, title: 'Colden Hamlet', blurb: 'Roll through Colden where the road runs right alongside the creek under the leafiest stretch of canopy; the quiet center of the valley, made for an easy pace.', kind: 'village', heading: 180 },
      { lat: 42.592, lon: -78.641, title: 'Lower Valley toward Glenwood', blurb: 'South of Colden the canopy opens to rolling wooded relief and the creek flats run down toward Glenwood — a relaxed down-valley close.', kind: 'forest', heading: 170 },
    ],
  },
  {
    id: 'zoar-valley-gorge',
    name: 'Gowanda–Zoar Valley Road Carver',
    theme: 'Tight wooded creek-valley carver',
    region: 'Gowanda Zoar & Zoar Valley Roads (CR 74 / CR 457A), Cattaraugus County, WNY',
    color: '#e11d48',
    summary:
      'One of the twistiest drivable corridors in Western New York. From Gowanda, Gowanda Zoar Road ' +
      'and then Zoar Valley Road (CR 74 → CR 457A) carve east up the wooded Cattaraugus Creek valley ' +
      'on the shoulder of the Zoar Valley wilderness — rhythmic, tree-walled curves with the green ' +
      'creek and rising shale walls below the road. Measured among the region’s best for turn density. ' +
      'The dramatic shale gorge itself is the hike-in Zoar Valley Multiple Use Area at the east end; ' +
      'the ride is the road, the gorge is the stop you park for.',
    whyRide:
      'Carve Gowanda Zoar Road into Zoar Valley Road — measured among WNY’s twistiest county roads — ' +
      'up the wooded Cattaraugus valley to the edge of the Zoar Valley gorge wilderness.',
    rubric: { curvature: 8, scenery: 9, greenery: 9, water: 7, notability: 7 },
    waypoints: [
      [42.46548, -78.93019], [42.4614, -78.91365], [42.4595, -78.89054], [42.4604, -78.86225],
      [42.45661, -78.83888], [42.4553, -78.8193], [42.4611, -78.80509], [42.46344, -78.78971], [42.46075, -78.7824],
    ],
    stops: [
      { lat: 42.4614, lon: -78.91365, title: 'Gowanda Zoar Road Valley', blurb: "Climb out of Gowanda on Gowanda Zoar Road as it bends up the wooded Cattaraugus valley — the start of one of WNY's twistiest county-road runs, hardwoods crowding both shoulders.", kind: 'forest', heading: 90 },
      { lat: 42.4595, lon: -78.89054, title: 'Cattaraugus Creek Valley', blurb: 'The road shadows the Cattaraugus Creek valley; gaps in the trees open onto the green water and the rising valley walls that deepen into the Zoar gorge downstream.', kind: 'water', heading: 120 },
      { lat: 42.4553, lon: -78.8193, title: 'Zoar Valley Road Twisties', blurb: 'Onto Zoar Valley Road proper — tight, rhythmic curves through dense forest (a measured ~265 turn-metres/km, among the region’s twistiest), the pavement rising and falling with the terrain.', kind: 'forest', heading: 90 },
      { lat: 42.46344, lon: -78.78971, title: 'Valentine Flats / Zoar Valley MUA', blurb: "The eastern end near the Zoar Valley Multiple Use Area and the Valentine Flats access — park here for the hike-in trails down to the dramatic shale gorge where the Cattaraugus's branches meet.", kind: 'gorge', heading: 70 },
    ],
  },
  {
    id: 'niagara-parkway-gorge-rim',
    name: 'Niagara Parkway Gorge Rim Cruise',
    theme: 'Gorge-rim river sunset cruise',
    region: 'Niagara Scenic Parkway, Niagara Gorge to Lewiston, WNY',
    color: '#10b981',
    summary:
      "Not a twisty road — this one is for the views. The still-drivable northern Niagara Scenic / " +
      'Robert Moses Parkway runs the US rim of the Niagara Gorge, past the Whirlpool and Devil’s ' +
      'Hole, then drops to Lewiston with the wide lower river opening up below. An easy evening cruise; ' +
      'best near sunset when the light rakes the Canadian escarpment across the water.',
    whyRide:
      'Cruise the US rim of the Niagara Gorge past the Whirlpool and Devil’s Hole, then drop into ' +
      'Lewiston as the sun sets over the lower river.',
    rubric: { curvature: 3, scenery: 8, greenery: 7, water: 10, notability: 9 },
    waypoints: [
      [43.082, -79.06], [43.101, -79.058], [43.125, -79.051], [43.149, -79.038],
      [43.178, -79.043], [43.21, -79.049], [43.25, -79.044],
    ],
    stops: [
      { lat: 43.119635, lon: -79.064006, title: 'Whirlpool State Park Rim', blurb: 'Walk to the rim wall at Whirlpool State Park: 300 feet below, the Niagara River doubles back on itself in a churn of green and white, the Aero Car cable strung across the gorge upstream.', kind: 'overlook', heading: 290 },
      { lat: 43.134301, lon: -79.044591, title: "Devil's Hole Gorge View", blurb: "From the Devil's Hole pull-off, look down into the most violent stretch of the gorge — the Whirlpool Rapids thundering between sheer 300-foot dolostone cliffs framed by forest.", kind: 'gorge', heading: 290 },
      { lat: 43.143232, lon: -79.039218, title: 'Niagara Power Vista', blurb: "The Power Authority's observation deck perched on the escarpment 350 feet above the river, looking north down the lower Niagara toward Lewiston with the generating complex below.", kind: 'viewpoint', heading: 274 },
      { lat: 43.164957, lon: -79.044529, title: 'Artpark Bluff over the Lower River', blurb: 'At Artpark the bluff opens onto the wide, calm lower Niagara emerging from the gorge — the Lewiston-Queenston bridge arcing across and the Canadian shore glowing at sunset.', kind: 'overlook', heading: 177 },
    ],
  },
  {
    id: 'lake-ontario-route18-byway',
    name: 'Lake Ontario Route 18 Byway',
    theme: 'Open-horizon lakeshore cruiser',
    region: 'NY-18 Seaway Trail, Wilson to Lakeside, Niagara/Orleans County, WNY',
    color: '#06b6d4',
    summary:
      'Flat and straight, but the payoff is an uninterrupted Lake Ontario horizon. NY-18 — the Great ' +
      'Lakes Seaway Trail — runs the lakeshore plain east from Wilson Harbor through Olcott’s working ' +
      'fishing harbor, with open water and big-sky views opening up at the creek mouths, parks, and ' +
      'harbors. A relaxed golden-hour cruiser, not a carver; the light over the open water at Olcott is the highlight.',
    whyRide:
      'An easy big-sky cruise down the Seaway Trail (NY-18) along the Lake Ontario shore — open-water ' +
      'horizons and a golden-hour stop at Olcott’s fishing harbor.',
    rubric: { curvature: 3, scenery: 6, greenery: 4, water: 8, notability: 7 },
    waypoints: [
      [43.3105, -78.8265], [43.337, -78.716], [43.344, -78.66], [43.351, -78.58],
    ],
    stops: [
      { lat: 43.3105, lon: -78.8265, title: 'Wilson Harbor', blurb: 'Start at Wilson on the harbor at the mouth of Twelvemile Creek — sailboats in the sheltered basin, the breakwater pier, and the open lake horizon past the harbor mouth.', kind: 'water', heading: 0 },
      { lat: 43.337623, lon: -78.716272, title: 'Olcott Harbor', blurb: 'The working fishing harbor at the mouth of Eighteenmile Creek: charter boats, the green pier light, and breakwalls framing the open lake — the classic Seaway Trail golden-hour stop.', kind: 'water', heading: 350 },
      { lat: 43.344, lon: -78.66, title: 'Lakeshore Farmland', blurb: 'East of Olcott the byway runs the orchard-and-farm plain set back from the bluff, the lake a steel-blue line off the left shoulder between the trees and fields.', kind: 'viewpoint', heading: 350 },
      { lat: 43.351, lon: -78.58, title: 'Lakeside Horizon', blurb: 'The road bends nearer the shore toward Lakeside Beach country — big sky, open water, and a long flat horizon to close the cruise.', kind: 'viewpoint', heading: 0 },
    ],
  },
];
