# Scenic-route methodology — adversarial audit & redesign

**Date:** 2026-06-20
**Trigger:** "Are we properly scouting and finding good scenic routes? Are we properly
rating these? The ones we currently have are kind of not impressive. Improve the
methodology — especially the route screenshots we share."

The owner's instinct was correct on every axis. This document records the adversarial
audit, the web research behind the fix, the root-cause diagnosis, and what changed.

## How this was audited

A multi-agent workflow ran 16 agents: six adversarial **auditors** (one per pipeline
dimension — scouting, curvature, rating, Street View, screenshots, geometry), each finding
re-checked by an independent **verifier** against the real files (false positives dropped),
plus three **web-research** agents. It produced **31 confirmed findings** and three research
briefs, synthesized into the redesign below. Every claim here was verified against the
committed code/data, not asserted.

## Diagnosis — why the routes felt unimpressive

Three compounding root causes:

### 1. Discovery never looked at roads
`gather-scenic.mjs` only queried POI nodes (viewpoint/waterfall/peak/…). The agentic
`scenic-workflow.js` then fanned out over **8 hand-typed corridors** clipped to a box that
**excluded** Chautauqua (NY-394/430) and the Southern Tier (Bristol Hills NY-64). The
candidate set was fixed by a human; the agents could only redecorate it. The app already
ships the right primitive — `overpass.ts scanRoads()` ranks real roads by measured
curvature — but the build pipeline never used it. So WNY's genuinely renowned riding roads
(**NY-242**, **US-219**, **NY-240** "dips and waves", **NY-39/Zoar**, **Letchworth Park
Road**, **Allegany ASP loops**) could never surface.

### 2. Curvature was hallucinated, and the docs claimed it was measured
`assemble-scenic.mjs` defined `curvatureDensity()` and **never called it** — it shipped the
language-model's 0–10 guess verbatim (with a comment rationalizing the discard). Yet the
README and the generated file header both claimed curvature was "measured from real road
geometry." Re-measuring the committed polylines proved the LLM numbers were wrong **both
ways**:

| Route | LLM curvature | Measured (rad/km → 0–10) |
|---|---|---|
| letchworth-gorge-rim-carver | 6 | **2.53 → 10** |
| niagara-gorge-rim | 4 | **1.97 → 7.9** |
| ny240-colden-carver | 5 | 1.60 → 6.4 |
| lake-ontario-seaway-trail | 3 | 0.71 → 2.8 |
| east-aurora-vermont-hill-**carver** | 6 | **1.14 → 4.5** |
| cattaraugus-springville-**carver** | 6 | **1.18 → 4.7** |

The two routes literally named **"Carver"** were among the *straightest* in the set.

### 3. Ranking rewarded famous water, not riding
The sort key was a single opaque LLM 0–100 score with no formula tying it to the rubric, so
curvature carried **zero** weight. The flattest two routes ranked #1 (a near-straight
parkway whose own summary calls it a "cruiser") and #2 (a lakeshore byway whose summary
says "not for twisties"), while the genuinely twisty gorge carver was buried at #3.

On top of these: **4 of 6 routes had out-and-back spurs** (the line drawing back on itself
and inflating distance up to ~6 km), and shared imagery was weak — the satellite path was a
1–2 px hairline, and Street View tiles silently rendered Google's gray "no imagery" box
instead of a fallback.

## What changed (shipped, deterministic — no regeneration required)

All of the following operate on the existing committed data / code and are covered by tests.

1. **Curvature is now MEASURED.** `src/lib/geometry.ts#curvature10` (radians/km → 0–10, the
   same scaling as the Live-scan tab) is computed from the cleaned geometry and written into
   `rubric.curvature`. The dead `curvatureDensity()` is gone.
2. **Score is a transparent composite.** `src/lib/scenicScore.ts#compositeScore` —
   motorcycle-weighted (curvature 0.35, scenery 0.20, greenery 0.15, water 0.15,
   notability 0.15). Reproducible and monotonic in the rubric; the LLM score is dropped.
3. **Geometry is cleaned.** `cleanCoords()` removes duplicate points and collapses
   out-and-back spurs (anchored on U-turn apexes; hairpins/switchbacks are preserved because
   they don't retrace). Distance/time are recomputed from the cleaned line.
4. **Re-ranking result** (`npm run scenic:recurate`):

   | Rank | Before (LLM score) | After (measured + composite) |
   |---|---|---|
   | 1 | niagara — 77 (cruiser) | **letchworth — 95** (twistiest, 2.53 rad/km) |
   | 2 | lake-ontario — 76 (straight) | niagara — 84 |
   | 3 | letchworth — 76 | ny240-colden — 59 |
   | 4 | east-aurora — 70 | lake-ontario — 52 |
   | 5 | ny240 — 62 | east-aurora — 49 |
   | 6 | cattaraugus — 58 | cattaraugus — 47 |

   Distances corrected by spur removal: lake-ontario 40.3→35.5 km, east-aurora 54.7→48.4 km,
   cattaraugus 64.3→60.1 km.
5. **Shared screenshots.** `staticRouteSatelliteUrl` now draws a bright emerald route over a
   dark casing (legible on water *and* forest) via an encoded polyline, with **numbered stop
   markers**. `streetViewStaticUrl` adds `return_error_code=true` (missing panos 404 into the
   designed fallback instead of a gray tile), `scale=2` (retina-crisp), and a tighter fov.
   Two stops left at the schema-default `heading:0` (which pointed the camera at the parking
   lot) were re-aimed. `index.html` gained Open Graph / Twitter meta so shared links unfurl
   intentionally.
6. **Honest docs + reproducible pipeline.** README/headers corrected; `snap-streetview.mjs`
   and `verify-roads.mjs` (previously orphaned) and the new discovery/recurate steps are now
   `scenic:*` npm scripts. `src/lib/scenicMetrics.test.ts` pins the invariants: stored
   curvature matches the measured value, score equals the composite, no `heading:0`, no
   spurs, distance matches geometry, slate sorted by score.

## The improved methodology (the "solution")

Curvature/twistiness, the metric a motorcyclist actually opens the app for, is computed —
never guessed — using the **circumcircle (Menger curvature)** method from the open
roadcurvature.com project: for every three consecutive points, the circumcircle radius is
the local turn radius; segments are bucketed by radius (175/100/60/30 m) and length-weighted
(0/1.0/1.3/1.6/2.0). This is implemented in `scripts/lib/scenic-metrics.mjs#twistiness` and
drives **road discovery** (`scripts/discover-roads.mjs`): instead of 8 hand-typed corridors,
the pipeline now enumerates WNY's paved through-roads across a widened box, scores each by
measured curvature, and feeds the **top-ranked corridors** to the agentic compose stage. The
route rubric uses the app's existing radians/km scaling so a road scores identically in the
scenic and Live-scan tabs.

### Discovery validation (benchmark)

`discover-roads.mjs` checks whether the renowned WNY roads from the research actually surface
in the ranking. Results from the run:

Run of 2026-06-20 — 36 tiles, **36,001 ways scanned → 1,802 ranked roads**. Benchmark
coverage **9/10**:

| Benchmark road | Rank | Tier |
|---|---|---|
| NY-240 Ashford "dips and waves" | #13 | excellent |
| NY-394 Chautauqua W | #34 | excellent |
| NY-16 Holland | #44 | excellent |
| NY-39 Zoar/Java | #126 | excellent |
| NY-430 Chautauqua E | #132 | excellent |
| NY-353 Amish Trail | #198 | pleasant |
| NY-64 Bristol Hills | #256 | pleasant |
| Letchworth Park Road | #335 | pleasant |
| NY-242 Ellicottville–Mansfield | #650 | pleasant |
| US-219 spine | — | excluded (limited-access expressway, correctly filtered) |

The headline point: the old pipeline could surface **zero** roads it wasn't hand-told about;
this stage finds the region's renowned twisties straight from the geometry. NY-240 — already
in our slate — independently ranks #13 of 1,802, corroborating the rating fix.

**Known refinements (follow-ups, not blockers):** the bounding box spills across the border,
so the raw top-25 is polluted with Ontario roads (Haldimand Rd 20, Niagara Pkwy ON, Hamilton
QEW service roads) — clip to the US side. And same-name aggregation (no `ref`) over-counts
common names ("Park Road", "Main Street") by merging unrelated segments region-wide — cluster
same-name ways spatially before scoring. NY-242 ranks lower than its reputation partly for
this reason (its famous climb is split across segments). See `scripts/data/discovered-roads.json`.

## Follow-ups (higher effort, not yet shipped)

- **Full agentic regeneration seeded by discovery** — swap the 8 hand-typed corridors for the
  discovered top roads and regenerate the slate so genuine gems (NY-242, US-219, Letchworth
  Park Road) enter the dataset. `scenic-workflow.js` is ready to consume
  `discovered-roads.json`.
- **Open-DEM grade signal** (OpenTopoData / AWS Terrarium, free/keyless) so ridge-and-valley
  roads — the celebrated WNY rides — up-rank on sustained elevation change.
- **Per-route share card + `navigator.share`** — a built raster OG image (satellite hero +
  title + score) and an in-app Share button; route URLs (`/#/ride/<id>`) so links deep-link.
- **Keyless hero basemap** — draw the route over a free OSM/Carto static tile so the no-key
  fallback (what the live site shows until the Maps key secret is added) looks finished.
- **Wire Street View verification into CI** as a hard gate (drop any stop with no pano).

## Key research sources

- roadcurvature.com — *How It Works* & `adamfranco/curvature` (circumcircle metric, radius
  bands 175/100/60/30 → weights 0/1/1.3/1.6/2, noise filtering, ≥300 "pleasant"/≥1000 "best").
- calimoto *Twisty Roads Algorithm*; Kurviger / GraphHopper `weighting=curvature`,
  `average_slope`/`max_slope` encoded values.
- OpenTopoData / Open-Elevation / AWS Terrain Tiles — free/keyless elevation & grade.
- Google Street View **image metadata** endpoint — free, no quota; pre-screen pano existence.
- WNY benchmark: motorcycleroads.com, Visit Buffalo scenic drives, Tour Chautauqua,
  Enchanted Mountains, Wikipedia (NY-242 / US-219 / NY-240 / NY-353 / NY-430). (NY-97
  "Hawk's Nest" is Orange County, not WNY — excluded as a false-positive tripwire.)
