import { ROLES, SELF_COLOR, TYPE_COLORS } from '../config';

// Mirrors ROLE_RING in config.js — the same three patterns, in CSS terms.
const RING_STYLE = { student: 'solid', faculty: 'dashed', staff: 'dotted' };

const LABELS = { student: 'Student', faculty: 'Faculty', staff: 'Staff' };

/**
 * The map's key.
 *
 * Three colours of dot with no key anywhere is not a map. The role colours are
 * separated in CIELAB rather than only in hue, and every marker also carries
 * its role as a text tooltip, so the meaning does not rest on colour alone.
 */
export function Legend() {
  return (
    <div className="legend">
      <div className="legend-title">Who's here</div>
      {ROLES.map((role) => (
        <div className="legend-row" key={role}>
          <span
            className="legend-key"
            style={{ background: TYPE_COLORS[role], borderStyle: RING_STYLE[role] }}
          />
          {LABELS[role]}
        </div>
      ))}
      <div className="legend-row you">
        <span className="legend-key" style={{ background: 'var(--self)' }} />
        You
      </div>
    </div>
  );
}
