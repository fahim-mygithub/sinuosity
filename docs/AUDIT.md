# Sinuosity Audit — 2026-06-19

Method: 13-agent parallel audit (6 dimensions × find → adversarially-verify → synthesize)
plus live runtime testing via Claude-in-Chrome against the dev server. 56 verified
findings from 65 raw (9 false positives / overstatements pruned by the verify pass).

## Executive summary

The app builds and runs cleanly (typecheck ✓, 15 unit tests ✓, clean console on load,
map renders with 72 tiles + 5 curated polylines). Two clusters of real defects block
the stated goals:

1. **Live-scan / Overpass map generation fails silently under real load.** A server-side
   query timeout returns **HTTP 200** with `{"elements":[],"remark":"runtime error: Query
   timed out..."}`. The client only checks `res.ok`, so it reports *"Found 0 twisty
   segments"* — a failure disguised as success. `runScan` also never passes the (already
   wired) `AbortSignal`, so the loader can hang ~37 s. Single endpoint, no retry/mirror,
   and a heavy `out body;>;out skel qt;` query that is itself the root cause of the timeouts.
2. **GitHub Pages deploy is hard-broken.** Vite `base` is unset → assets emit `/assets/*`
   and 404 at `/sinuosity/`. Not a git repo; no CI/deploy workflow.

A secondary correctness bug (planar lat/lon distorts sinuosity ~22% on real routes) plus
test gaps round out the substantive work. Everything else is real-but-minor polish.

## Runtime evidence (Claude-in-Chrome)

| Probe | Result |
|---|---|
| Initial load | Clean console (only Vite + React DevTools). 72 tiles, 5 polylines, home marker. |
| Live scan (UI) | Toast: *"OpenStreetMap is busy — lower the radius and retry"* |
| Direct fetch 25 km (heavy query) | 37.7 s, HTTP 200, 372 bytes |
| Direct fetch 8 km (heavy query) | 27.5 s, HTTP 200, `elements:[]` + timeout `remark` |
| **Direct fetch 15 km, `out geom;` (lightweight)** | **21 s, HTTP 200, 3514 ways / 1968 with geometry** ← the fix |
| Mirrors (kumi, private.coffee) | timed out at 70 s (congested) — `overpass-api.de` is the reliable primary |
| Node-side fetch | 406 unless a real `User-Agent` + form content-type are sent |
| Viewport | `innerWidth` 2844 px; app has no max-width → chrome stretches edge-to-edge |

## Prioritized fixes

### Critical / High (map-gen + console + deploy)
1. **`base: '/sinuosity/'`** in `vite.config.ts` — unblocks Pages (assets 404 otherwise).
2. **Detect Overpass `remark`** → `throw new OverpassError(remark, 'timeout')` so timeouts
   stop masquerading as empty success.
3. **AbortController + timeout in `runScan`**, pass `signal`, `clearTimeout` in `finally`,
   disable Scan button while scanning (kills ~37 s hang + concurrent requests).
4. **Per-kind error toasts** + throw `'empty'` kind so "no roads" ≠ "query failed".
5. **Lightweight `out geom;` query** (inline geometry, no node-map needed), bounded
   (`[timeout:15]`, lower default radius, way cap) + **retry/backoff across mirrors**.
6. **GitHub Actions Pages workflow** + `git init` (depends on #1).

### Medium
7. `cos(lat)` longitude correction in `geometry.ts` (sinuosity ~22% distortion).
8. Dedupe same-named OSM ways in the scan list (draw all polylines, dedupe rows).
9. a11y: label range inputs (`id`/`htmlFor`/`aria-label`), tab roles, `role="status"` toast.
10. Desktop: constrain chrome (header/toast/sheet) in a centered `max-w` container; keep map full-bleed.
11. Bump `vite`/`vitest` to patched releases (5 dev-only advisories; prod `dist` unaffected).
12. Add `overpass.test.ts` + `scoring.test.ts` to lock new behavior.

### Low (selected)
- `rel="noopener noreferrer"` on external links.
- `Number.isFinite` guard in `mapsUrl` builders (latent `NaN` → broken link).
- `useMemo` for `scoreAndSort`.
- favicon + `theme-color` + `description` meta (base-path-aware).
- **OSM attribution control** (license obligation — Leaflet `attributionControl` is currently disabled).
- **`404.html` SPA fallback** for Pages deep-link refresh.
- Skip-partial-way guard for coordinate gaps; document curated-vs-scanned score scales.

## Out of scope of findings but worth noting (completeness check)
OSM fair-use / `User-Agent` policy on retries; optional `navigator.geolocation` instead of
hardcoded HOME; no error telemetry; fixes here are verified by re-test, not yet by a
real-device mobile-Safari pass.
