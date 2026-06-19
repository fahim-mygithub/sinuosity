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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

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
