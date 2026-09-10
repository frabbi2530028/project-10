import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { FALLBACK_CENTER, ROLE_RING, SELF_COLOR, TYPE_COLORS } from '../config';

// A divIcon rather than a circleMarker, so the pulse can be plain CSS.
// anchor = half of the 18px icon, to centre it on the actual coordinate.
const selfIcon = L.divIcon({
  className: 'live-dot-icon',
  html:
    '<span class="live-dot">' +
    '<span class="live-dot-ring"></span>' +
    '<span class="live-dot-ring delayed"></span>' +
    '<span class="live-dot-core"></span>' +
    '</span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

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

    // A light basemap, so the map is part of the white interface rather than
    // a bright rectangle sitting in the middle of it. Carto's Positron keeps
    // roads and labels legible while staying pale enough that the coloured
    // markers are the only saturated thing on screen. {r} serves @2x tiles to
    // retina displays.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
        '© <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);

    // NOTE: intentionally no click/tap-to-set-location handler. Your own
    // position must always come from the device's real GPS fix.
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      // map.remove() destroys the layers but not our references to them.
      // Leaving them set means the next mount takes the "already exists"
      // branch and calls setLatLng on a marker belonging to a destroyed map,
      // which never gets added to the new one — so after a sign-out and back
      // in, your own dot and everyone else's would simply never reappear.
      myMarkerRef.current = null;
      myAccCircleRef.current = null;
      markersRef.current = {};
      hasFitOthersOnce.current = false;
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
      // addTo() before bindTooltip() is load-bearing: a permanent tooltip is
      // opened at bind time only if the layer is already on the map. Swap
      // these two lines and the "You" label silently never appears, because
      // the mouseover path that would otherwise open it is disabled by
      // interactive: false.
      //
      // No zIndexOffset needed — an L.marker lives in markerPane (600) and
      // everyone else's circleMarkers are in overlayPane (400), so your own
      // dot is already above them.
      const marker = L.marker([lat, lng], {
        icon: selfIcon,
        keyboard: false,
        interactive: false,
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
          color: SELF_COLOR,
          fillColor: SELF_COLOR,
          fillOpacity: 0.07,
          weight: 1,
          opacity: 0.35,
          interactive: false,
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

      // White stroke, not dark: on a pale basemap a light ring reads as a
      // raised bead, while a dark one reads as a hole punched in the map.
      const marker = L.circleMarker([loc.lat, loc.lng], {
        radius: 8,
        fillColor: TYPE_COLORS[loc.type] || '#9aa2b4',
        color: '#ffffff',
        weight: 2.5,
        opacity: 1,
        fillOpacity: 0.95,
        // Solid / dashed / dotted ring per role — see ROLE_RING.
        dashArray: ROLE_RING[loc.type] || null,
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
