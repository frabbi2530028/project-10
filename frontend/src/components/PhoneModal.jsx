import { useEffect, useState } from 'react';
import { API_BASE } from '../config';
import { CloseIcon, CopyIcon, PhoneIcon } from './Icons';

const isLocalHost = () => /^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(window.location.hostname);

/**
 * Share/pairing modal.
 *
 * Once the app is deployed the site itself has a public HTTPS URL, so that is
 * what we hand out. The tunnel URL from /api/network-info is only relevant
 * during local development, where the page is on localhost and a phone can't
 * reach it otherwise.
 */
export default function PhoneModal({ open, onClose }) {
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);

    if (!isLocalHost()) {
      setShareUrl(window.location.origin);
      return;
    }

    // Local dev: ask the backend for its public tunnel URL so a phone can join.
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/network-info`);
        const info = await resp.json();
        if (!cancelled) setShareUrl(info.public_https_url || info.local_ip_url || window.location.origin);
      } catch {
        if (!cancelled) setShareUrl(window.location.origin);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const qrSrc = shareUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=4&data=${encodeURIComponent(shareUrl)}`
    : null;

  return (
    <div
      id="phone-modal-overlay"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target.id === 'phone-modal-overlay') onClose();
      }}
    >
      <div className="modal-card">
        <div className="modal-icon">
          <PhoneIcon />
        </div>
        <h2>Join from your phone</h2>
        <p>
          Scan this QR code with your phone's camera. Your phone's real GPS will activate and share your live location
          with everyone else on the map.
        </p>
        <div className="qr-container" id="qrContainer">
          {qrSrc ? (
            <img src={qrSrc} alt="Scan to open on your phone" />
          ) : (
            <span className="qr-loading">Generating QR code…</span>
          )}
        </div>
        <div className="url-box" id="tunnelUrlBox">
          <strong>{shareUrl || 'Preparing link…'}</strong>
        </div>
        <div className="modal-actions">
          <button className="btn-copy" onClick={copy}>
            <CopyIcon />
            {copied ? 'Copied!' : 'Copy Link'}
          </button>
          <button className="btn-close-modal" onClick={onClose}>
            <CloseIcon />
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
