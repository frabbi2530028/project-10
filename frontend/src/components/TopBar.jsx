import { CrosshairIcon, MenuIcon, PhoneIcon, ShieldIcon, TrashIcon, UsersIcon, WifiIcon } from './Icons';

function StatusBadge({ id, icon: Icon, text, variant }) {
  return (
    <span id={id} className={`status-badge ${variant || ''}`.trim()}>
      <Icon />
      <span className="badge-text">{text}</span>
    </span>
  );
}

export default function TopBar({
  connected,
  onToggleConnection,
  onOpenPhone,
  onSpawnSimulated,
  onClearSimulated,
  onSignOut,
  student,
  gps,
  menuOpen,
  onToggleMenu,
  hasFix,
}) {
  // The single dot summarises on mobile what the two full badges show on
  // desktop: green = connected, amber = no GPS fix yet.
  const dotVariant = connected ? 'active' : hasFix ? '' : 'warning';

  return (
    <div id="topbar">
      <div className="brand">
        <div className="brand-mark">
          <ShieldIcon />
        </div>
        <div className="brand-text">
          <h1>StudentMap</h1>
          <p>Live campus map</p>
        </div>
      </div>

      {/* Mobile-only: compact live status dot + menu toggle */}
      <div className="topbar-mobile-actions">
        <span id="statusDot" className={`status-dot ${dotVariant}`.trim()} title="Connection status" />
        <button className="btn-menu" onClick={onToggleMenu} aria-label="Open controls">
          <MenuIcon />
        </button>
      </div>

      <div className={`controls ${menuOpen ? 'open' : ''}`.trim()}>
        <div className="sheet-handle" />

        <button className={`btn-connect ${connected ? 'connected' : ''}`.trim()} onClick={onToggleConnection}>
          <span className="dot" />
          <span className="btn-label">{connected ? 'Connected' : 'Connect'}</span>
        </button>

        <button className="btn-phone" onClick={onOpenPhone}>
          <PhoneIcon />
          <span>Share Link</span>
        </button>

        <button className="btn-sim" onClick={onSpawnSimulated}>
          <UsersIcon />
          <span>Add Simulated</span>
        </button>

        <button className="btn-sim danger" onClick={onClearSimulated}>
          <TrashIcon />
          <span>Clear</span>
        </button>

        <StatusBadge id="gpsBadge" icon={CrosshairIcon} text={gps.text} variant={gps.variant} />
        <StatusBadge id="status" icon={WifiIcon} text={connected ? 'Online' : 'Offline'} variant={connected ? 'active' : ''} />

        <div className="account-row">
          <span className="account-email" title={student?.email}>{student?.email}</span>
          <button className="btn-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
