import { useCallback, useState } from 'react';
import TopBar from './components/TopBar';
import MapView from './components/MapView';
import LocationBanner from './components/LocationBanner';
import PhoneModal from './components/PhoneModal';
import LoginScreen from './components/LoginScreen';
import ContourField from './components/ContourField';
import { Legend } from './components/Panels';
import { useGeolocation } from './hooks/useGeolocation';
import { useLocationSocket } from './hooks/useLocationSocket';
import { useViewportHeight } from './hooks/useViewportHeight';
import { useAuth } from './hooks/useAuth';
import { usePointerGlow } from './hooks/usePointerGlow';
import { useMediaQuery } from './hooks/useMediaQuery';
import { API_BASE, SIMULATION_ENABLED } from './config';

export default function App() {
  useViewportHeight(); // keeps the layout pinned to the real viewport on iOS

  // The bar has no tilt — it is fixed furniture, not a card you can pick up.
  const topBarRef = usePointerGlow({ maxTilt: 0 });

  // On a phone the map is very nearly full-bleed, so the contour drawing would
  // be running a full-screen trace every frame to fill a few millimetres of
  // gutter. Not worth the battery on the weakest device we target; the sign-in
  // screen still gets it in full.
  const narrow = useMediaQuery('(max-width: 650px)');

  // Lights the map sheet under the cursor. No tilt — the sheet lies flat.
  const mapFrameRef = usePointerGlow({ maxTilt: 0 });

  const { session, restoring, signIn, signOut } = useAuth();

  const [wantConnection, setWantConnection] = useState(true); // auto-connect once a fix arrives
  const [people, setPeople] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  const { position, gps, hint, setHint, requestPermission } = useGeolocation();

  const onLocations = useCallback((data) => setPeople(data), []);

  // Only students can sign in for now, so the role comes from the verified
  // identity rather than a dropdown — your role should follow from who you
  // are, not from what you pick. Faculty and staff slot in here later.
  const role = session?.student?.role || 'student';

  const handleAuthRejected = useCallback(() => {
    setPeople([]);
    signOut();
  }, [signOut]);

  const { connected, myId } = useLocationSocket({
    enabled: wantConnection && Boolean(session),
    role,
    position,
    token: session?.token,
    onLocations,
    onAuthRejected: handleAuthRejected,
  });

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const toggleConnection = () => {
    if (!position) {
      setHint({
        visible: true,
        text: "Waiting for your exact GPS location — this can't be set manually.",
        showButton: true,
      });
      return;
    }
    const next = !wantConnection;
    setWantConnection(next);
    if (next) {
      closeMenu(); // connecting: get the sheet out of the way of the map
    } else {
      setPeople([]); // disconnecting: drop everyone else's markers
    }
  };

  const openPhone = () => {
    closeMenu(); // don't stack the modal on top of the mobile sheet
    setPhoneOpen(true);
  };

  const handleSignOut = () => {
    closeMenu();
    setPeople([]);
    signOut();
  };

  // Simulated users are a local testing aid. They are not offered in a
  // production build: the endpoints are disabled there, and a live campus map
  // full of invented dots is worse than no map at all.
  const spawnSimulated = async () => {
    if (!position) return;
    try {
      await fetch(`${API_BASE}/api/simulate/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center_lat: position.lat,
          center_lng: position.lng,
          radius_meters: 600,
          count: 10,
        }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  const clearSimulated = async () => {
    try {
      await fetch(`${API_BASE}/api/simulate`, { method: 'DELETE' });
    } catch (e) {
      console.error(e);
    }
  };

  // Reading the stored session takes one tick. Returning null would blank the
  // page for that tick and then pop the card in; showing the backdrop instead
  // means the first paint is already the finished composition.
  if (restoring) {
    return (
      <div className="login-screen">
        <ContourField />
        <div className="grain" aria-hidden="true" />
      </div>
    );
  }

  if (!session) {
    return <LoginScreen onAuthenticated={signIn} />;
  }

  return (
    <>
      {/* The backdrop belongs to this screen too. The map is inset like a
          survey sheet on a drafting table, so the live contour drawing stays
          visible around it rather than being covered over after sign-in. */}
      {!narrow && <ContourField />}

      {/* Everything behind the dialog is made inert while it is open. The
          overlay stops the mouse and the focus trap stops Tab, but neither
          removes this content from the accessibility tree — a screen reader's
          browse mode would still reach "Sign out" behind a modal dialog.
          `display: contents` keeps the flex layout of #root unchanged. */}
      <div className="app-shell" inert={phoneOpen}>
      <TopBar
        barRef={topBarRef}
        connected={connected}
        onToggleConnection={toggleConnection}
        onOpenPhone={openPhone}
        onSpawnSimulated={SIMULATION_ENABLED ? spawnSimulated : null}
        onClearSimulated={SIMULATION_ENABLED ? clearSimulated : null}
        onSignOut={handleSignOut}
        student={session.student}
        gps={gps}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        hasFix={Boolean(position)}
      />

      <div id="sheet-scrim" className={menuOpen ? 'open' : ''} onClick={closeMenu} />

      <LocationBanner hint={hint} onEnableLocation={requestPermission} />

      <div className="map-frame" ref={mapFrameRef}>
        <MapView position={position} people={people} myId={myId} />
        {/* A surveyor's loupe: a soft lift of light that follows the cursor
            across the sheet. Decorative and inert to pointer events. */}
        <div className="map-lens" aria-hidden="true" />
      </div>

      <Legend />
      </div>

      <PhoneModal open={phoneOpen} onClose={() => setPhoneOpen(false)} />

      {/* Above everything, so the grain unifies the whole surface instead of
          stopping at the edge of each panel. */}
      <div className="grain" aria-hidden="true" />
    </>
  );
}
