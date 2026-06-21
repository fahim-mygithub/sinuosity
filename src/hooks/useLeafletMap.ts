import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { HOME } from '../lib/mapsUrl';

export function useLeafletMap(containerId: string) {
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(containerId, { zoomControl: false, attributionControl: true }).setView(HOME, 10);
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Google web-tiles via the `mt{0-3}.google.com/vt` endpoint (lyrs: m=roads, s=satellite,
    // y=hybrid, p=terrain). NOTE: this is Google's internal tile host, used here because the app
    // already ships a Google Maps key for imagery and the rider asked for the familiar Google
    // basemap. It is technically outside Google's Maps TOS for public sites — the compliant
    // alternative is Google's billed Map Tiles API. Kept as switchable layers so the OSM-derived
    // CARTO/OSM bases remain a one-tap fallback (and the lawful default if Google is ever pulled).
    const google = (lyrs: string, label: string) =>
      L.tileLayer(`https://{s}.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`, {
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        maxZoom: 20,
        attribution: `&copy; <a href="https://www.google.com/intl/en/help/terms_maps/">Google</a> · ${label}`,
      });
    const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    });
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });

    const googleRoads = google('m', 'Roads');
    const bases: Record<string, L.TileLayer> = {
      'Google Roads': googleRoads,
      'Google Satellite': google('s', 'Satellite'),
      'Google Hybrid': google('y', 'Hybrid'),
      'Dark (CARTO)': carto,
      'OSM Standard': osm,
    };
    googleRoads.addTo(map); // default basemap
    L.control.layers(bases, undefined, { position: 'topright', collapsed: true }).addTo(map);

    const homeIcon = L.divIcon({
      className: '',
      html: `<div style="width:28px;height:28px;background:#34d399;border-radius:9999px;border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.5)"><span style="font-size:12px">🏠</span></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    L.marker(HOME, { icon: homeIcon }).addTo(map).bindPopup('<b>36 Char Del Way</b><br>Home');

    mapRef.current = map;
    setReady(true);

    const onResize = () => map.invalidateSize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      map.remove();
      mapRef.current = null;
    };
  }, [containerId]);

  const clearLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.forEach((l) => { try { map.removeLayer(l); } catch { /* already gone */ } });
    layersRef.current = [];
  }, []);

  const addLayer = useCallback((layer: L.Layer) => {
    const map = mapRef.current;
    if (!map) return;
    layer.addTo(map);
    layersRef.current.push(layer);
  }, []);

  return { map: mapRef.current, ready, clearLayers, addLayer, layers: layersRef };
}
