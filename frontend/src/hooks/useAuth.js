import { useCallback, useEffect, useState } from 'react';
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
    const token = session?.token;
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
  }, [session]);

  return { session, restoring, signIn, signOut };
}
