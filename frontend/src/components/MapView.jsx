import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { FALLBACK_CENTER, TYPE_COLORS } from '../config';

/**
 * Leaflet is driven imperatively through refs rather than via a React
 * wrapper library: the marker bookkeeping here (per-user circle markers,
 * one-time fitBounds) maps 1:1 onto the original implementation, and
 * keeping it explicit avoids a wrapper re-rendering the map on every
 * GPS tick.
 */
export default function MapView({ position, people, myId }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const myMarkerRef = useRef(null);
  const myAccCircleRef = useRef(null);
  const markersRef = useRef({}); // user_id -> L.circleMarker
  const hasFitOthersOnce = useRef(false);

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    const start = position || FALLBACK_CENTER;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([start.lat, start.lng], 17);

    // Standard OpenStreetMap tiles — full colour and richly detailed
    // (buildings, POIs, labelled roads), free, and no API key.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    // NOTE: intentionally no click/tap-to-set-location handler. Your own
    // position must always come from the device's real GPS fix.
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaflet caches its container size at init and only repaints the area it
  // thinks it has. On iOS the viewport changes constantly as Safari's
  // toolbars slide in and out, which left the map rendered at a stale size
  // with an unpainted black band below it. A ResizeObserver on the container
  // catches every cause of a size change — toolbars, rotation, keyboard —
  // and invalidateSize() makes Leaflet re-measure and fill the space.
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return undefined;

    const refresh = () => map.invalidateSize();

    const observer = new ResizeObserver(refresh);
    observer.observe(el);

    window.addEventListener('orientationchange', refresh);
    window.visualViewport?.addEventListener('resize', refresh);

    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', refresh);
      window.visualViewport?.removeEventListener('resize', refresh);
    };
  }, []);

  // Own position: marker + accuracy circle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;

    const { lat, lng, accuracy } = position;

    if (myMarkerRef.current) {
      myMarkerRef.current.setLatLng([lat, lng]);
    } else {
      const marker = L.circleMarker([lat, lng], {
        radius: 10,
        fillColor: '#fbbf24',
        color: '#fff7e6',
        weight: 3,
        fillOpacity: 1,
      }).addTo(map);
      marker.bindTooltip('You', {
        permanent: true,
        direction: 'top',
        offset: [0, -12],
        className: 'you-tooltip',
      });
      myMarkerRef.current = marker;
      map.setView([lat, lng], map.getZoom()); // centre once, on first fix
    }

    if (accuracy && accuracy < 2000) {
      if (myAccCircleRef.current) {
        myAccCircleRef.current.setLatLng([lat, lng]);
        myAccCircleRef.current.setRadius(accuracy);
      } else {
        myAccCircleRef.current = L.circle([lat, lng], {
          radius: accuracy,
          color: '#f59e0b',
          fillColor: '#f59e0b',
          fillOpacity: 0.1,
          weight: 1,
        }).addTo(map);
      }
    }
  }, [position]);

  // Everyone else's dots.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activeIds = new Set();

    people.forEach((loc) => {
      activeIds.add(loc.id);
      if (loc.id === myId) return; // we already have our own marker

      const existing = markersRef.current[loc.id];
      if (existing) {
        existing.setLatLng([loc.lat, loc.lng]);
        return;
      }

      const marker = L.circleMarker([loc.lat, loc.lng], {
        radius: 8,
        fillColor: TYPE_COLORS[loc.type] || '#ffffff',
        color: '#0b0f19',
        weight: 2,
        opacity: 0.95,
        fillOpacity: 0.92,
      });
      // Anonymous role tooltip — no name, no student ID.
      marker.bindTooltip(loc.type.charAt(0).toUpperCase() + loc.type.slice(1), {
        direction: 'top',
        offset: [0, -8],
      });
      marker.addTo(map);
      markersRef.current[loc.id] = marker;
    });

    // Drop anyone who disconnected.
    Object.keys(markersRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        map.removeLayer(markersRef.current[id]);
        delete markersRef.current[id];
      }
    });

    // The first time anyone else shows up, fit them into view — the tight
    // initial zoom on your own position can otherwise leave a real, connected
    // person just off-screen. Only once, so it never fights your own panning.
    const otherCount = Object.keys(markersRef.current).length;
    if (otherCount > 0 && !hasFitOthersOnce.current && position) {
      hasFitOthersOnce.current = true;
      const points = [[position.lat, position.lng]];
      Object.values(markersRef.current).forEach((m) => points.push(m.getLatLng()));
      map.fitBounds(points, { padding: [60, 60], maxZoom: 17 });
    }
  }, [people, myId, position]);

  return <div id="map" ref={containerRef} />;
}
