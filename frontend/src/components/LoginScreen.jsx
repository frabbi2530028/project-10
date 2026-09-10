import { useState } from 'react';
import { API_BASE } from '../config';
import { usePointerGlow } from '../hooks/usePointerGlow';
import ContourField from './ContourField';
import { ShieldIcon } from './Icons';

/**
 * Student sign-in.
 *
 * The email/ID pair is checked by the backend (POST /api/login) rather than
 * here, so the rule has a single authoritative home and can't be edited away
 * in the browser. A successful login returns a session token, which is then
 * required to open the location WebSocket.
 */
export default function LoginScreen({ onAuthenticated }) {
  // Lights and tilts the card as the pointer crosses it.
  const cardRef = usePointerGlow({ maxTilt: 5 });

  const [email, setEmail] = useState('');
  const [studentId, setStudentId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const resp = await fetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), student_id: studentId.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.detail || 'Sign in failed. Check your details and try again.');
        return;
      }
      onAuthenticated({ token: data.token, student: data.student });
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <ContourField />
      <div className="grain" aria-hidden="true" />

      {/* The entrance animates the shell and the tilt transforms the card.
          Keeping them on separate elements is what lets both work: an
          entrance with a forwards fill permanently retains the properties it
          animates, so an entrance on the card itself would pin `transform`
          and the tilt would never apply. */}
      <div className="login-card-shell">
        <form className="login-card" ref={cardRef} onSubmit={submit}>
        <div className="brand-mark login-mark">
          <ShieldIcon />
        </div>

        <h1>StudentMap</h1>
        <p className="login-sub">Sign in with your UIU student account</p>

        <label className="field">
          <span className="field-label">UIU email</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            placeholder="Enter your UIU email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? 'true' : undefined}
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Student ID</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="username"
            placeholder="Enter your student ID"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value.replace(/\D/g, '').slice(0, 10))}
            aria-invalid={error ? 'true' : undefined}
            required
          />
        </label>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className={`login-submit ${busy ? 'busy' : ''}`.trim()}
          disabled={busy}
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>

          <p className="login-note">
            Your ID and email must agree — the trimester and roll number in each have to match.
          </p>
        </form>
      </div>
    </div>
  );
}
