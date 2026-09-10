import { useMediaQuery } from '../hooks/useMediaQuery';
import { CrosshairIcon, MenuIcon, PhoneIcon, ShieldIcon, TrashIcon, UsersIcon, WifiIcon } from './Icons';

// Matches the breakpoint in styles.css where the controls become a sheet.
const SHEET_QUERY = '(max-width: 650px)';

function StatusBadge({ id, icon: Icon, text, variant }) {
  return (
    <span id={id} className={`status-badge ${variant || ''}`.trim()}>
      <Icon />
      <span>{text}</span>
    </span>
  );
}

export default function TopBar({
  barRef,
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
  // Below this width the controls are a sheet that closes; above it they are
  // always-visible bar furniture and must never be made inert.
  const isSheet = useMediaQuery(SHEET_QUERY);

  // The single dot summarises on mobile what the two full badges show on
  // desktop: green = connected, amber = no GPS fix yet. The badges that spell
  // it out live inside the sheet, which is closed by default on exactly the
  // viewport where the dot is shown — so the dot needs to carry the meaning
  // in text as well as in colour.
  const dotVariant = connected ? 'active' : hasFix ? '' : 'warning';
  const statusLabel = connected
    ? 'Connected'
    : hasFix
      ? 'Not connected'
      : 'Waiting for a GPS fix';

  return (
    <div id="topbar" ref={barRef}>
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
        <span
          id="statusDot"
          className={`status-dot ${dotVariant}`.trim()}
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
        />
        <button
          className="btn-menu"
          onClick={onToggleMenu}
          aria-expanded={menuOpen}
          aria-controls="topbar-controls"
          aria-label={menuOpen ? 'Close controls' : 'Open controls'}
        >
          <MenuIcon />
        </button>
      </div>

      {/* `inert` keeps the closed sheet out of the tab order and away from
          assistive tech. CSS visibility handles it too, but inert is the part
          that is guaranteed — a sheet moved off-screen by a transform alone
          stays focusable, stranding keyboard users on controls they cannot
          see. Only applies below 650px, where the sheet actually closes.

          Must be a real boolean: React 19 treats `inert` as a boolean
          attribute, so an empty string is falsy and REMOVES it. */}
      <div
        id="topbar-controls"
        className={`controls ${menuOpen ? 'open' : ''}`.trim()}
        inert={!menuOpen && isSheet}
      >
        <div className="sheet-handle" />

        <button className={`btn-connect ${connected ? 'connected' : ''}`.trim()} onClick={onToggleConnection}>
          <span className="dot" />
          <span>{connected ? 'Connected' : 'Connect'}</span>
        </button>

        <button className="btn-phone" onClick={onOpenPhone}>
          <PhoneIcon />
          <span>Share Link</span>
        </button>

        {/* Testing-only, and absent entirely from a production build. */}
        {onSpawnSimulated && (
          <button className="btn-sim" onClick={onSpawnSimulated}>
            <UsersIcon />
            <span>Add Simulated</span>
          </button>
        )}

        {onClearSimulated && (
          <button className="btn-sim danger" onClick={onClearSimulated}>
            <TrashIcon />
            <span>Clear</span>
          </button>
        )}

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
