import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../config';

const STORAGE_KEY = 'studentmap.session';

/**
 * Holds the signed-in student and their session token.
 *
 * The session is kept in localStorage so a reload (or coming back to the tab
 * on a phone) doesn't force a re-login. Tokens live in the server's memory,
 * so a backend restart invalidates them — the socket then refuses to open and
 * we clear the stale session and show the login screen again.
 */
export function useAuth() {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);

  // signOut reads the token from here rather than closing over `session`, so
  // its identity stays stable. Consumers put it in dependency arrays, and a
  // callback that changed on every sign-in would churn their effects.
  //
  // Written in an effect, not during render: under concurrent rendering a
  // render that is abandoned would still have mutated the ref.
  const sessionRef = useRef(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSession(JSON.parse(raw));
    } catch {
      // Corrupt or unavailable storage (private mode) — just start signed out.
    }
    setRestoring(false);
  }, []);

  const signIn = useCallback((next) => {
    setSession(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal: the session simply won't survive a reload.
    }
  }, []);

  const signOut = useCallback(() => {
    const token = sessionRef.current?.token;
    setSession(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (token) {
      // Best effort — the local session is gone either way.
      fetch(`${API_BASE}/api/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }).catch(() => {});
    }
  }, []);

  return { session, restoring, signIn, signOut };
}
