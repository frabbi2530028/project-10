import { useEffect, useRef, useState } from 'react';
import { WS_BASE } from '../config';

const HEARTBEAT_MS = 3000;

/**
 * Owns the WebSocket to the FastAPI backend.
 *
 * Note the effect deliberately depends on `hasFix` (a boolean) rather than on
 * the position object — otherwise every GPS tick would tear down and rebuild
 * the socket. Position updates are pushed separately in the second effect.
 */
export function useLocationSocket({ enabled, role, position, token, onLocations, onAuthRejected }) {
  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState(null);

  const wsRef = useRef(null);
  const positionRef = useRef(position);
  positionRef.current = position;

  // Keep the latest callbacks without making them effect dependencies.
  const onLocationsRef = useRef(onLocations);
  onLocationsRef.current = onLocations;
  const onAuthRejectedRef = useRef(onAuthRejected);
  onAuthRejectedRef.current = onAuthRejected;

  const hasFix = Boolean(position);

  useEffect(() => {
    if (!enabled || !hasFix || !token) return undefined;

    // A browser can't set headers on a WebSocket handshake, so the session
    // token goes in the query string.
    const ws = new WebSocket(`${WS_BASE}/ws/${role}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    let heartbeat = null;

    const sendLocation = () => {
      const pos = positionRef.current;
      if (ws.readyState === WebSocket.OPEN && pos) {
        ws.send(JSON.stringify({ action: 'location', lat: pos.lat, lng: pos.lng }));
      }
    };

    ws.onopen = () => {
      setConnected(true);
      sendLocation();
      heartbeat = setInterval(sendLocation, HEARTBEAT_MS);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === 'welcome') {
          setMyId(msg.data.user_id);
        } else if (msg.event === 'locations') {
          onLocationsRef.current?.(msg.data);
        } else if (msg.event === 'error') {
          console.error('Server error:', msg.data.message);
        }
      } catch (e) {
        console.error('Error parsing WS message:', e);
      }
    };

    ws.onclose = (event) => {
      setConnected(false);
      setMyId(null);
      // 1008 = the server refused the session (unknown or expired token,
      // e.g. after a backend restart). Surface it so the app can send the
      // student back to the login screen instead of sitting on "Offline".
      if (event.code === 1008) {
        onAuthRejectedRef.current?.();
      }
    };

    ws.onerror = (err) => console.error('WebSocket error:', err);

    return () => {
      if (heartbeat) clearInterval(heartbeat);
      ws.onclose = null; // avoid a setState after unmount
      ws.close();
      wsRef.current = null;
      setConnected(false);
      setMyId(null);
    };
  }, [enabled, hasFix, role, token]);

  // Push each new fix immediately, on top of the periodic heartbeat.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && position) {
      ws.send(JSON.stringify({ action: 'location', lat: position.lat, lng: position.lng }));
    }
  }, [position]);

  return { connected, myId };
}
