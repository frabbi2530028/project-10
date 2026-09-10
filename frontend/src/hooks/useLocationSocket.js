import { useEffect, useRef, useState } from 'react';
import { WS_BASE } from '../config';

// How often to re-send our position even when it hasn't changed. It doubles as
// a liveness signal: the server drops users it stops hearing from.
const HEARTBEAT_MS = 3000;

// Reconnect backoff. A dropped socket is usually a passing blip (a phone
// changing cell, Wi-Fi handover, the free-tier backend waking up), so retry
// quickly at first and back off to avoid hammering a server that is genuinely
// down.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// 1008 = policy violation: the server rejected our session token. Retrying
// with the same token can only fail the same way, so this one is terminal.
const CLOSE_POLICY_VIOLATION = 1008;

/**
 * Owns the WebSocket to the FastAPI backend.
 *
 * The effect deliberately depends on `hasFix` (a boolean) rather than on the
 * position object — otherwise every GPS tick would tear down and rebuild the
 * socket. Position updates are pushed separately by the second effect.
 */
export function useLocationSocket({ enabled, role, position, token, onLocations, onAuthRejected }) {
  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState(null);

  const wsRef = useRef(null);
  const positionRef = useRef(position);
  const onLocationsRef = useRef(onLocations);
  const onAuthRejectedRef = useRef(onAuthRejected);

  // Kept in refs so the socket effect doesn't re-run (and reconnect) every
  // time a caller passes a new inline callback or a new GPS fix arrives.
  useEffect(() => {
    positionRef.current = position;
    onLocationsRef.current = onLocations;
    onAuthRejectedRef.current = onAuthRejected;
  });

  const hasFix = Boolean(position);

  useEffect(() => {
    if (!enabled || !hasFix || !token) return undefined;

    let cancelled = false;
    let heartbeat = null;
    let retryTimer = null;
    let retryDelay = RECONNECT_MIN_MS;

    const stopHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const connect = () => {
      // A browser can't set headers on a WebSocket handshake, so the session
      // token goes in the query string.
      const ws = new WebSocket(`${WS_BASE}/ws/${role}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      const sendLocation = () => {
        const pos = positionRef.current;
        if (ws.readyState === WebSocket.OPEN && pos) {
          ws.send(JSON.stringify({ action: 'location', lat: pos.lat, lng: pos.lng }));
        }
      };

      ws.onopen = () => {
        if (cancelled) return;
        retryDelay = RECONNECT_MIN_MS; // the connection works again
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
        stopHeartbeat();
        wsRef.current = null;
        if (cancelled) return;

        setConnected(false);
        setMyId(null);

        // The server refused the session (unknown or expired token, e.g.
        // after a backend restart). Send the student back to the login
        // screen rather than retrying a token that will never work.
        if (event.code === CLOSE_POLICY_VIOLATION) {
          onAuthRejectedRef.current?.();
          return;
        }

        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
      };

      // 'error' is always followed by 'close', so reconnection is handled
      // there and this only needs to report.
      ws.onerror = () => console.warn('WebSocket error; will retry if it closes.');
    };

    connect();

    return () => {
      cancelled = true;
      stopHeartbeat();
      if (retryTimer) clearTimeout(retryTimer);

      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null; // don't reconnect (or setState) after unmount
        ws.close();
        wsRef.current = null;
      }
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
