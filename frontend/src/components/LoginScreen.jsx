import { useState } from 'react';
import { API_BASE } from '../config';
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
      <form className="login-card" onSubmit={submit}>
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
            placeholder="frabbi2530028@bsds.uiu.ac.bd"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Student ID</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="username"
            placeholder="0152530028"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value.replace(/\D/g, '').slice(0, 10))}
            required
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>

        <p className="login-note">
          Your ID and email must agree — the trimester and roll number in each have to match.
        </p>
      </form>
    </div>
  );
}
