// Build-time twin of src/lib/features.ts `categorizeFeatures` — raw Overpass elements to
// {tells, pois}.
//
// The tile builder bakes this output and the BROWSER consumes it directly (tileSource decodes it
// straight into the same FeatureCatalog the Overpass path produces), so any divergence here ships
// a scan whose scenery scores differ depending on which data source served it. src/lib/features.
// test.ts holds a PARITY test running both implementations over the same elements.
//
// Ported deliberately line-for-line rather than "improved" — if you want to change the scoring,
// change src/lib/features.ts first, then mirror it here and let the parity test confirm.

const WATER_SIZE = { coastline: 1.0, canal: 0.85, lake: 0.8, river: 0.5, stream: 0.3 };
const SMALL_POND_W = 0.2;
const BIG_WATER_M2 = 40000;
const DS = 40;

function polygonAreaM2(ring) {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const R = 6371000;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xy = ring.map((p) => [((p[1] * Math.PI) / 180) * R * k, ((p[0] * Math.PI) / 180) * R]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function downsamplePts(pts, max = DS) {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

function geomOf(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { pt: [el.lat, el.lon], ring: null };
  if (Array.isArray(el.geometry) && el.geometry.length) {
    const ring = el.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => [g.lat, g.lon]);
    return ring.length ? { pt: ring[0], ring } : null;
  }
  if (Array.isArray(el.members)) {
    const ring = [];
    for (const m of el.members) {
      if (Array.isArray(m.geometry)) {
        for (const g of m.geometry) if (g && Number.isFinite(g.lat)) ring.push([g.lat, g.lon]);
      }
    }
    return ring.length ? { pt: ring[0], ring } : null;
  }
  return null;
}

/** Categorize raw Overpass elements into {tells, pois}. Mirrors features.ts categorizeFeatures. */
export function categorizeFeatures(elements) {
  const tells = {
    waterPts: [], waterAreas: [], greenAreas: [], greenPts: [],
    uglyAreas: [], uglyPts: [], view: [], peak: [], notable: [],
  };
  const pois = [];
  const pushNotable = (t) => { tells.notable.push(t); };

  for (const el of elements) {
    const g = geomOf(el);
    const t = el.tags;
    if (!g || !t) continue;
    const verts = g.ring ? downsamplePts(g.ring) : [g.pt];
    const notable = !!(t.wikidata || t.wikipedia);

    if (t.tourism === 'viewpoint') {
      tells.view.push(g.pt);
      if (notable) pushNotable({ pt: g.pt, w: 1.0 });
      pois.push({ pt: g.pt, name: t.name, kind: 'viewpoint', notable, source: t.wikidata, weight: 1.0 });
    } else if (t.natural === 'peak' || t.natural === 'cliff') {
      tells.peak.push(g.pt);
      if (notable) pushNotable({ pt: g.pt, w: 0.8 });
      pois.push({ pt: g.pt, name: t.name, kind: 'viewpoint', notable, source: t.wikidata, weight: 0.8 });
    } else if (t.natural === 'coastline') {
      for (const v of verts) tells.waterPts.push({ pt: v, w: WATER_SIZE.coastline });
      pois.push({ pt: g.pt, name: t.name, kind: 'water', notable, weight: WATER_SIZE.coastline });
    } else if (t.natural === 'water') {
      const areaM2 = g.ring ? polygonAreaM2(g.ring) : 0;
      const open = areaM2 >= BIG_WATER_M2 || notable || !!t.name;
      const w = open ? WATER_SIZE.lake : SMALL_POND_W;
      if (g.ring && open) tells.waterAreas.push(g.ring);
      for (const v of verts) tells.waterPts.push({ pt: v, w });
      if (notable) pushNotable({ pt: g.pt, w: 0.9 });
      pois.push({ pt: g.pt, name: t.name, kind: 'water', notable, source: t.wikidata, weight: w });
    } else if (t.waterway) {
      const w = t.waterway === 'canal' ? WATER_SIZE.canal : t.waterway === 'river' ? WATER_SIZE.river : WATER_SIZE.stream;
      for (const v of verts) tells.waterPts.push({ pt: v, w });
      pois.push({ pt: g.pt, name: t.name, kind: 'water', notable, weight: w });
    } else if (
      t.natural === 'wood' || t.landuse === 'forest' || t.leisure === 'park' ||
      t.leisure === 'nature_reserve' || t.boundary === 'national_park' || t.boundary === 'protected_area'
    ) {
      if (g.ring) tells.greenAreas.push(g.ring);
      for (const v of verts) tells.greenPts.push(v);
      const isPark = t.boundary === 'national_park';
      if (notable || isPark) pushNotable({ pt: g.pt, w: isPark ? 1.0 : 0.7 });
      pois.push({ pt: g.pt, name: t.name, kind: 'forest', notable: notable || isPark, source: t.wikidata, weight: isPark ? 1.0 : 0.7 });
    } else if (t.landuse || t.man_made === 'works') {
      if (g.ring) tells.uglyAreas.push(g.ring);
      for (const v of verts) tells.uglyPts.push(v);
    }
  }

  return { tells, pois };
}
