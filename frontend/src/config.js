/**
 * Backend location.
 *
 * Local dev  → leave VITE_BACKEND_URL unset. Vite's proxy (vite.config.js)
 *              forwards /api and /ws to FastAPI on :8000, so same-origin works.
 * Production → set VITE_BACKEND_URL in Netlify to the Render service URL,
 *              e.g. https://studentmap-api.onrender.com
 */
const rawBackend = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');

export const API_BASE = rawBackend || '';

export const WS_BASE = rawBackend
  ? rawBackend.replace(/^http/, 'ws')
  : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// The "Add Simulated" / "Clear" controls exist for local testing only. The
// backend refuses those endpoints in production (ENABLE_SIMULATION=0), so the
// buttons would just error — better not to show them at all.
export const SIMULATION_ENABLED = import.meta.env.DEV;

// The map palette lives here and only here — Leaflet needs literal colour
// strings for its SVG attributes, so a CSS variable cannot be the source, and
// the legend reads these same values rather than a second set of CSS tokens.
//
// SELF_COLOR is the one exception: it is also --self in styles.css, because
// CSS styles the pulsing dot and the tooltip while Leaflet styles the accuracy
// circle. Change one and you must change the other, or the ring around your
// own marker stops matching its centre.
//
// Privacy preserved: a dot carries a colour and a role, never an identity.
// The three roles are UIU's own brand colours (orange and slate, read from
// uiu.ac.bd's theme stylesheet) plus a teal that separates cleanly from both.
// SELF_COLOR sits deliberately outside that palette so your own dot can never
// be mistaken for somebody else's. All four are separated in CIELAB (ΔE > 44
// pairwise), not merely in hue, and each clears 3:1 against the paper.
export const TYPE_COLORS = {
  student: '#b0600e', // UIU orange, deepened to clear 3:1 on the paper
  faculty: '#2f4858', // UIU slate, straight from their stylesheet
  staff: '#1c7d70', // Teal — the third that separates cleanly from both
};

// Your own marker, and the accuracy halo around it.
export const SELF_COLOR = '#6b4c9a';

export const ROLES = ['student', 'faculty', 'staff'];

// A second channel for role, so the map does not encode meaning in hue alone.
// The colours are ΔE-separated, but that is no help to a colour-blind user;
// the ring pattern is legible regardless. Values are Leaflet dashArray
// strings, mirrored by the legend's border-style.
export const ROLE_RING = {
  student: null,      // solid
  faculty: '4 3',     // dashed
  staff: '1 3',       // dotted
};

// Fallback map centre used only until a real GPS fix arrives
export const FALLBACK_CENTER = { lat: 23.8103, lng: 90.4125 };
