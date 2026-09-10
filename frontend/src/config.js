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

// Color mapping (privacy preserved: only colour + role, never an identity)
export const TYPE_COLORS = {
  student: '#fb7185', // Rose
  faculty: '#60a5fa', // Blue
  staff: '#34d399', // Emerald
};

export const ROLES = ['student', 'faculty', 'staff'];

// Fallback map centre used only until a real GPS fix arrives
export const FALLBACK_CENTER = { lat: 23.8103, lng: 90.4125 };
