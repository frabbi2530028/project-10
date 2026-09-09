import { useCallback, useState } from 'react';
import TopBar from './components/TopBar';
import MapView from './components/MapView';
import LocationBanner from './components/LocationBanner';
import PhoneModal from './components/PhoneModal';
import { useGeolocation } from './hooks/useGeolocation';
import { useLocationSocket } from './hooks/useLocationSocket';
import { useViewportHeight } from './hooks/useViewportHeight';
import { API_BASE } from './config';

export default function App() {
  useViewportHeight(); // keeps the layout pinned to the real viewport on iOS

  const [role, setRole] = useState('student');
  const [wantConnection, setWantConnection] = useState(true); // auto-connect once a fix arrives
  const [people, setPeople] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  const { position, gps, hint, setHint, requestPermission } = useGeolocation();

  const onLocations = useCallback((data) => setPeople(data), []);

  const { connected, myId } = useLocationSocket({
    enabled: wantConnection,
    role,
    position,
    onLocations,
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

  return (
    <>
      <TopBar
        role={role}
        onRoleChange={setRole}
        connected={connected}
        onToggleConnection={toggleConnection}
        onOpenPhone={openPhone}
        onSpawnSimulated={spawnSimulated}
        onClearSimulated={clearSimulated}
        gps={gps}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        hasFix={Boolean(position)}
      />

      <div id="sheet-scrim" className={menuOpen ? 'open' : ''} onClick={closeMenu} />

      <LocationBanner hint={hint} onEnableLocation={requestPermission} />

      <PhoneModal open={phoneOpen} onClose={() => setPhoneOpen(false)} />

      <MapView position={position} people={people} myId={myId} />

      {/* The Legend and Live Info panels are intentionally not rendered —
          they cluttered the map. The components still exist in
          components/Panels.jsx; render them here again to bring them back. */}
    </>
  );
}
