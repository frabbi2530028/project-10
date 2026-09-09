export function Legend() {
  return (
    <div className="panel legend">
      <div className="panel-title">Legend</div>
      <div className="legend-row">
        <span className="legend-dot" style={{ background: 'var(--student)' }} />
        Student
      </div>
      <div className="legend-row">
        <span className="legend-dot" style={{ background: 'var(--faculty)' }} />
        Faculty
      </div>
      <div className="legend-row">
        <span className="legend-dot" style={{ background: 'var(--staff)' }} />
        Staff
      </div>
      <div className="legend-row you">
        <span className="legend-dot" style={{ background: 'var(--you)' }} />
        You
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

export function InfoPanel({ role, position, nearby, connected }) {
  return (
    <div className="panel info-panel">
      <div className="panel-title">Live Info</div>
      <Row label="Role" value={connected ? role.toUpperCase() : '—'} />
      <Row label="GPS Acc." value={position ? `±${Math.round(position.accuracy)}m` : '—'} />
      <Row label="Lat" value={position ? position.lat.toFixed(5) : '—'} />
      <Row label="Lng" value={position ? position.lng.toFixed(5) : '—'} />
      <Row label="Nearby" value={nearby} />
    </div>
  );
}
