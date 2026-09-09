import { useCallback, useEffect, useRef, useState } from 'react';

const isMobileUA = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isIOSUA = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * Watches the device's real GPS position.
 *
 * There is deliberately no manual/click-to-set path anywhere in this app:
 * your own position always comes from the device's actual fix, so nobody
 * can drop a fake pin for themselves.
 *
 * Returns { position, gps, hint, requestPermission }.
 */
export function useGeolocation() {
  const [position, setPosition] = useState(null); // { lat, lng, accuracy }
  const [gps, setGps] = useState({ text: 'GPS: Waiting', variant: '' });
  const [hint, setHint] = useState({ visible: false, text: '', showButton: false });

  const watchIdRef = useRef(null);

  const showHint = useCallback((text, showButton) => {
    setHint({ visible: true, text, showButton });
  }, []);

  const start = useCallback(() => {
    setGps({ text: 'GPS: Requesting…', variant: '' });

    // iOS Safari (and most mobile browsers) refuse geolocation outright on an
    // insecure origin — no permission prompt is ever shown, it just silently
    // fails. Catch that case with a specific, actionable message.
    if (window.isSecureContext === false) {
      setGps({ text: 'GPS: Insecure Link', variant: 'warning' });
      showHint(
        'This link is not secure (http://), so the browser blocks location access entirely — even before asking. Open this page over HTTPS instead.',
        false
      );
      return;
    }

    if (!('geolocation' in navigator)) {
      setGps({ text: 'GPS: Not Supported', variant: 'warning' });
      showHint('This browser has no GPS support. Open the site on a phone with real GPS instead.', false);
      return;
    }

    // Show the manual "Tap to Enable Location" fallback immediately. Some
    // mobile browsers (notably iOS Safari) only show the system location
    // prompt when the request comes from a tap — an automatic request on page
    // load can silently do nothing, with no prompt and no error. A visible
    // button from the start means you're never stuck with no way to trigger it.
    showHint('Waiting for GPS lock — if no location permission popup appeared, tap below.', true);

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const accuracy = Math.round(pos.coords.accuracy || 10);
        setGps({ text: `GPS: ±${accuracy}m`, variant: 'active' });
        setHint((h) => ({ ...h, visible: false }));
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy });
      },
      (err) => {
        console.warn('GPS watch error:', err);
        const mobile = isMobileUA();
        const ios = isIOSUA();

        // GeolocationPositionError: 1 = PERMISSION_DENIED,
        // 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        if (err.code === 1) {
          setGps({ text: 'GPS: Permission Denied', variant: 'warning' });
          if (ios) {
            showHint(
              'Location is blocked for this page. On iPhone: Settings ▸ Privacy & Security ▸ Location Services must be ON, and Settings ▸ Safari ▸ Location must be "Ask" (not "Never"). Then reload and tap below.',
              true
            );
          } else if (mobile) {
            showHint('Location permission was denied. Enable it for this site in your browser settings, then reload and tap below.', true);
          } else {
            showHint(
              'Location unavailable. Enable it in macOS Settings ▸ Privacy & Security ▸ Location Services, or open this site on your phone for a real GPS fix.',
              true
            );
          }
        } else if (err.code === 3) {
          setGps({ text: 'GPS: Timed Out', variant: 'warning' });
          if (mobile) {
            showHint('GPS is taking a while to lock (weak signal / indoors?). Still trying — tap below to retry now.', true);
          } else {
            showHint(
              'This computer has no GPS chip — it can only approximate location via Wi-Fi, which just timed out. Open the site on your phone for your real position.',
              true
            );
          }
        } else {
          // POSITION_UNAVAILABLE or unrecognised. A laptop with no GPS
          // hardware failing a Wi-Fi lookup lands here far more often than in
          // the permission-denied branch, so it needs the same steer.
          setGps({ text: 'GPS: Unavailable', variant: 'warning' });
          if (mobile) {
            showHint('Could not get a GPS fix. Make sure Location Services is on for this browser, then tap below to retry.', true);
          } else {
            showHint(
              'This computer has no GPS chip — Wi-Fi based location failed. Check macOS Settings ▸ Privacy & Security ▸ Location Services is ON for your browser, or open the site on your phone for your real, exact position.',
              true
            );
          }
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }, [showHint]);

  useEffect(() => {
    start();
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [start]);

  return { position, gps, hint, setHint, requestPermission: start };
}
