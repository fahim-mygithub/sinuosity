# Reel category — validation evidence

Measurements taken against the live APIs on 2026-08-01, to test the premises in
`2026-08-01-reel-category-design.md` before building on them. Scripts were
throwaway; the numbers are reproducible from the method notes here.

Status: in progress. Findings that changed the design are marked **→ DESIGN CHANGE**.

---

## 1. Open-Meteo DEM horizontal resolution — measured, not assumed

**Method.** Sampled a 600 m east–west transect at 10 m steps across the Zoar Valley
area (42.4436, −78.8710) and measured run-lengths of identical returned values. The
sampling grid shows through as repeats.

```
distinct values:      10 of 60
identical-run lengths: [2, 7, 7, 6, 7, 7, 7, 7, 7, 3]   mean 6.0
implied grid spacing:  ~60–70 m
```

3 arc-seconds of longitude at 42°N is 111320 × cos(42°) / 1200 = **68.9 m**, which
matches the observed ~7-sample runs. So the served DEM is a **3 arc-second (nominal
90 m) product**, and at this latitude a longitude step of ~69 m.

**Consequences:**

- **→ DESIGN CHANGE.** The proposed near-field screening probe at 30–50 m is
  meaningless — it lands in the *same DEM cell* as the road and can only ever return
  a delta of 0. Near-field screening must come from OSM polygons alone. (The design
  already sourced screening from polygons; what changes is that the DEM can never be
  a fallback for it.)
- **→ DESIGN CHANGE.** The proposed 150 m far-field probe is ~2 cells out — marginal.
  Probe distances move to **200 / 400 / 800 / 1500 m**.

## 2. Does terrain fall actually separate a gorge road from a flat road?

**Method.** Perpendicular probes both sides of travel at 150 / 400 / 1000 m,
reporting metres of fall relative to the road.

| site | max fall |
|---|---|
| Zoar Valley rim | 31 m |
| Letchworth rim | 26 m |
| Allegany ridge | 33 m |
| Flat farmland N of Alden | 4 m |
| Ellicottville village | −1 m (ground *rises* +92 m at 1 km — correctly reads as "in a bowl") |
| Lake Erie shore | **0 m** |

**The signal is real but much smaller than assumed.** The design said "40–80 m of
fall"; the measured separation is gorge ~26–33 m against farmland ~4 m.

- **→ DESIGN CHANGE.** Openness threshold drops to **≥15 m of fall**, not 40 m.
- Note these sample points were coordinate guesses, not real road geometry, so they
  probably *understate* the gorges (Zoar is far deeper than 31 m in reality). An
  end-to-end run on real OSM road geometry is the fair test.

### 2a. End-to-end run on REAL road geometry, with a negative control

Fetched actual OSM geometry, walked each road in 200 m steps, probed perpendicular at
200 / 400 / 800 / 1500 m both sides. Negative-control roads were chosen as the three
LONGEST ways in two flat farmland bboxes with no name filter — no cherry-picking.

| road | mean best fall | segments ≥15 m |
|---|---|---|
| Letchworth Park Rd (gorge) | **130.3 m** | left 0% / **right 100%** |
| Zoar Valley Rd (gorge) | 23.3 m | **left 58%** / right 0% |
| NY-5 Lake Erie shore | 17.7 m | **left 67%** / right 0% |
| Buckwheat Rd (flat farm) | 1.6 m | 0% |
| Crittenden Rd (flat farm) | 10.2 m | 0% |
| County Line Rd (flat farm) | 10.3 m | 20% |
| Stone Rd (flat farm) | 5.6 m | 0% |
| Slayton Settlement Rd (flat farm) | 11.6 m | 50% |
| Ridge Rd (flat farm) | 7.9 m | 0% |

**The mechanism works, and the side asymmetry is clean.** Letchworth reads 0% left /
100% right — it runs the gorge rim with the drop consistently on one side, which is
exactly the "which side is the backdrop" output the design needs. Zoar and NY-5 are
likewise one-sided.

**Honest limits, and these matter:**

- Flat farmland means ~7.9 m. So Letchworth separates by **16×**, but Zoar (23.3) and
  the Lake Erie shore (17.7) separate by only **2.2–2.9×**. The detector reliably
  finds *major* relief; modest relief is weakly separated. **→ DESIGN CHANGE:** for
  modest-relief roads, lean on water polygons and Street View confirmation rather
  than trusting the terrain probe alone.
- The "fraction of segments ≥15 m" metric produced **two false positives** in flat
  country — Slayton Settlement Rd at 50%, County Line Rd at 20% — while their *mean*
  fall stayed low (11.6 and 10.3 m). (Slayton may not be a true false positive: the
  Niagara Escarpment runs through there, and a neighbouring road is literally named
  Ridge Road.) **→ DESIGN CHANGE:** rank on **magnitude**, not on a thresholded
  count, and use **side consistency** as a second term — a genuine shelf road has its
  fall on ONE side for most of its length.
- **→ DESIGN CHANGE:** no single probe distance works. Zoar's signal is at 200–800 m
  and **vanishes to 0 at 1500 m** (the far plateau returns to road height); Letchworth's
  *grows* with distance (34 → 129 → 142 → 149 m). Max-over-distances is required, and
  the distance at which the max occurs is itself informative — it is roughly the scale
  of the landform.

**Two failure modes confirmed:**

- **Water is invisible to the DEM.** Lake Erie shore returned 0 m of fall, because a
  lake surface is flat — there is nothing to fall into. **→ DESIGN CHANGE:** water
  backdrop must come from OSM water polygons; the terrain probe cannot contribute.
  The two mechanisms are non-overlapping and both are required.
- **The far wall rises again.** Letchworth returned L[−26, −26, +14] — falling at 150
  and 400 m, rising at 1000 m. Sampling only the far distance would have called this
  "no view". **→ DESIGN CHANGE:** the metric is **max fall at ANY probe distance**,
  never the fall at the outermost one.

## 3. OSM coverage of the proposed new tell classes

**Method.** Overpass counts within 15 km of Ellicottville (42.28, −78.67) — 707 km².

| class | elements |
|---|---|
| `landuse=residential` | **4** |
| `landuse=industrial\|retail\|commercial\|quarry\|landfill` (already used today) | **2** |
| `highway=stop\|traffic_signals` | 11 |

**This is the most serious finding so far.** The design called anti-suburbia "the
single biggest win per hour of work", resting on `landuse=residential`. In rural WNY
that polygon class is essentially unmapped.

Two readings, and they have opposite consequences:

- **Benign:** rural areas genuinely have no residential landuse, suburban areas do,
  and the asymmetry *is* the signal.
- **Fatal:** the class is patchy everywhere in this region, so a suburban road can
  read as clean — a false negative, which is the dangerous direction.

**Resolved.** Counts within a 2 km radius (≈12.6 km²) of seven sites:

| site | residential landuse | residential+service roads | buildings | power |
|---|---|---|---|---|
| Amherst (suburban) | 40 | 1888 | 959 | 19 |
| Cheektowaga (suburban) | 6 | 1609 | 858 | 49 |
| Orchard Park (outer suburb) | 1 | 559 | 165 | 0 |
| Ellicottville (village) | 1 | 198 | 1116 | 0 |
| Zoar Valley (rural gorge) | 0 | 13 | 97 | 1 |
| Allegany SP (rural forest) | 0 | 54 | 124 | 0 |
| Farmland N of Alden (rural) | 0 | 130 | 10 | 0 |

| signal | suburban mean | rural mean | separation |
|---|---|---|---|
| `landuse=residential` | 15.7 | 0.0 | ∞ but degenerate |
| **`highway=residential\|service`** | **1352** | **65.7** | **20.6×** |
| buildings | 660.7 | 77.0 | 8.6× |
| `power=line\|minor_line` | 22.7 | 0.3 | 68× but zero-inflated |

**→ DESIGN CHANGE. The primary suburbia signal becomes `highway=residential|service`
way density, not `landuse=residential`.** Reasons, in order:

1. Residential landuse is **0 at every rural site**, so it cannot rank rural roads
   against each other at all — and ranking rural roads is the entire job. It also
   collapses in the transitional zone that matters most (Orchard Park, a real
   suburb, scored 1).
2. Road density is **monotone across the whole range** — 1888 / 1609 / 559 / 198 /
   130 / 54 / 13 — so it discriminates *within* rural too. Zoar (13) reads as
   genuinely more remote than Alden farmland (130), which matches reality.
3. Roads are the best-mapped class in OSM; landuse polygons are drawn by hand and
   patchy.

Power lines are kept as a **confirmatory** signal only (68× separation is excellent
but four of seven sites are 0 — useless as a primary term).

**Buildings are rejected**: Ellicottville village returned **1116 buildings, more
than suburban Amherst's 959**, because a dense village core fills a 2 km radius. The
signal inverts exactly where we need it.

Queried with `out center;` (one point per way) the payload stays small, and it can
ride along with the road query the app already makes.

## 4. Overpass operational notes

- The API **406s on Node's default User-Agent**. Not an app issue (browsers send a
  real one), but every probe script needs an explicit UA.
- Sustained probing gets **429-rate-limited** quickly. A supplementary reel-tells
  query must be a *single* combined request, not several.

## 5. Street View already does most of the backdrop job — and was missed

`src/lib/scenicImagery.ts:28` `streetViewStaticUrl(lat, lon, heading, …)` already
exists and already takes a **heading**. So the app can render the actual view
perpendicular to travel at any point on a route, today, with the key that is already
wired.

**→ DESIGN CHANGE.** This is a better answer to "is there a backdrop here" than any
amount of DEM inference, because it shows the rider the real view instead of
inferring one. The split becomes:

- **map data + DEM → RANKING.** Cheap, covers every candidate road, no quota.
- **Street View → CONFIRMATION.** Costs a request per frame, so it runs only on the
  handful of marks in the shoot card the rider actually opens.

This also directly de-risks finding 3: even if the suburbia signal proves weak, the
rider sees a frame of the actual roadside before committing to a two-hour ride.

## 6. Sharpening: what the sun model should actually output

Not a score. A rider cannot change a road's bearing — they can change **which
direction they ride it** and **when they start**. Riding the same road the other way
inverts backlit and frontlit entirely.

**→ DESIGN CHANGE.** The sun model's deliverable is a **direction of travel and a
start time** ("ride this west-to-east starting 19:50"), with the per-segment
lighting classification as supporting detail.

---

## 6a. The golden-hour budget was ~40% too small — **→ DESIGN CHANGE**

Caught by a test, not by review. `src/lib/sun.ts` computes the evening golden window
(+6° to −4°) at Buffalo on 31 July as **59.6 minutes**. The design doc asserted
"~35–40 minutes at 42°N in late July".

The implementation is right and the assumption was wrong. Near the horizon the sun
descends at roughly 15°/hr × cos(latitude) = **11°/hr at 42.9°N**, so the 10° band
takes ~55 min. The 29-test suite validates the module against first principles
independently — equinox and solstice noon elevations, the equation of time's known
±16.4 / −14.2 min extremes, the equinox sunrise bearing, and symmetry about solar
noon — so the ~60 min figure is trustworthy.

**Consequence:** a Reel ride has roughly **45 km** of budget at 45 mph, not ~30. The
default `targetKm` of 22 is comfortably inside the light rather than nearly filling
it, which leaves room to prefer a longer, more varied ride.

---

## 7. Literature review — what is supported and what I invented

Sourced review of the landscape-aesthetics and scenic-routing literature. Full
provenance in the research agent's report; the load-bearing items:

### 7.1 The openness/enclosure conflict largely dissolves — **→ DESIGN CHANGE**

Seresinhe et al. 2017 (*Royal Society Open Science*), verified at source:

> "'No Horizon' and 'Open Area' are both negatively associated with scenicness in
> our model"

**Both ends are penalised.** These are not two poles of one axis to trade off. The
high-scoring configuration is a **framed view** — structure in frame *and* something
to look out over. Featureless open ground scores badly; so does having no view out.

For the 360-reframe case this is unusually actionable: the location serving *both*
virtual cameras is the **edge** — treeline meeting a falling valley, road threading
the boundary between cover and view. **So the detector to build is an edge/transition
detector, not an "enclosure score" and an "openness score" used separately.** That
resolves the conflict the design was built around rather than trading it off.

Prospect–refuge theory (Appleton) is neither superseded nor strongly confirmed —
Dosen & Ostwald's 2016 meta-analysis finds evidence still inconsistent, with prospect
better supported than refuge. **No quantified preferred ratio exists**; ours will be
a tuning constant, and must be labelled as one.

### 7.2 Flat green is UNSCENIC — **→ DESIGN CHANGE, and a likely existing bug**

Verified quote: *"Large areas of greenspace such as 'Grass' and 'Athletic Field'
appear to be unscenic in both models."* Trees positive; flat green negative.

`features.ts` currently pools `natural=wood`, `landuse=forest`, `leisure=park`,
`leisure=nature_reserve` and protected areas into ONE `greenAreas` bucket feeding
`greenery`. A municipal park of mown lawn therefore scores identically to closed
forest. **Reel must separate tree cover from grass cover, and only tree cover may
feed enclosure.** Whether to also fix this for Scenic/Scan is a separate call — it
would move existing baked scores.

### 7.3 Well-supported dimensions

- **Relief/ruggedness → scenic.** Two independent lineages (Seresinhe; BLM Visual
  Resource Inventory H-8410-1). The safest dimension we have.
- **Water → scenic.** Three lineages. Important qualifier: BLM scores water on
  **dominance of the scene**, not mere presence. Our boolean "open water within
  120 m" is a weaker construct than the literature's.
- **No distance-decay function for water proximity exists in the literature.**
  `TAU.water = 500` is invented. Label it a tuning constant.

### 7.4 Claims that FAILED, including two the downstream project relies on

- **The "1.5 s action-cam legibility floor" is not empirical.** Traced to GAZED
  (arXiv 2010.11886), where it is an **imposed, uncited hyperparameter** set "for
  fair comparison." Scene-gist detection works at ~13 ms. 1.5 s is a sane editorial
  default; it is not a perceptual threshold. `D:\MotoProject\CLAUDE.md` and
  `templates/golden_hour.json` both cite it as sourced fact.
- **The "~1200 ms post-cut gaze locked to screen centre" figure is untraceable as
  stated** — almost certainly an *analysis bin boundary* from Rothkegel et al. 2017
  mistaken for a result, conflated with attentional-synchrony work (Mital/Smith).
  The defensible version: after a cut, gaze converges hard and is centre-biased,
  decaying over roughly the first second. Keep the principle, drop the number.
- **Tree-cover dose-response curve shape: do not act on it.** The "inverted-U" traces
  to a single lab (Jiang/Larsen/Sullivan) presenting as three findings, and the
  inverted-U result is for *stress recovery, men only, urban streets* — not
  scenicness.
- **Visual-variety cost: no literature either way.** Our `variety` dimension has zero
  academic backing. It is supported only by this project's own n=1 experience (canopy
  on 53% of marks forcing all four templates to neuter the tag). Ship it, label it
  honestly as a designed heuristic.

### 7.5 Prior art — we are not first

**Alivand & Hochmair** (*Computers, Environment and Urban Systems*) computed scenery
attributes "ranging from road curviness to the viewshed from the road elements" using
a DTM plus volunteered geographic information, and found water, mountains, forests
and parks along a route raise scenic-route choice probability while urban areas lower
it. That is close to what this design proposes. Full text not retrieved — flagged as
the highest-value remaining gap.

**BLM VRI H-8410-1 is the best operational template**: seven factors — landform,
vegetation, water, colour, **adjacent scenery**, scarcity, cultural modifications.
"Adjacent scenery" (scenery *outside* the rated unit, influencing it over 0–5 miles)
is the institutional precedent for our perpendicular probe.

**Topographic openness / sky-view factor** (Yokoyama et al. 2002) is a real, standard
method — but **no study validates it against human scenicness ratings.** The
computation is well-founded; calling it a scenicness proxy is our own unvalidated
inference and must be documented as such.
