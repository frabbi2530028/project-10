import { useEffect, useRef, useState } from 'react';
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
  const [qrFailed, setQrFailed] = useState(false);

  const cardRef = useRef(null);
  const closeRef = useRef(null);

  // Escape, focus in on open, focus back to the opener on close, and a Tab
  // loop that stays inside the card. Without these a keyboard user has no way
  // out but to hunt for the Close button, and a screen reader is never told a
  // dialog appeared.
  useEffect(() => {
    if (!open) return undefined;

    const opener = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = cardRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Send focus back where it came from. Deliberately not conditional on
      // the dialog still containing focus: this cleanup is a passive effect,
      // so React has already unmounted the card and nulled cardRef by the
      // time it runs — that test could only ever be false. Focus is inside
      // the dialog by construction while it is open, because it is trapped.
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    setCopied(false);
    setQrFailed(false);

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
      onClick={(e) => {
        if (e.target.id === 'phone-modal-overlay') onClose();
      }}
    >
      <div
        className="modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-modal-title"
      >
        <div className="modal-icon">
          <PhoneIcon />
        </div>
        <h2 id="phone-modal-title">Join from your phone</h2>
        <p>
          Scan this QR code with your phone's camera. Your phone's real GPS will activate and share your live location
          with everyone else on the map.
        </p>
        <div className="qr-container" id="qrContainer">
          {qrSrc && !qrFailed ? (
            // The QR image comes from a third-party service, so it can fail
            // independently of everything else here — offline, blocked, or
            // down. The link below is the real payload and still works.
            <img
              src={qrSrc}
              alt="Scan to open StudentMap on your phone"
              onError={() => setQrFailed(true)}
            />
          ) : (
            <span className={qrFailed ? 'qr-failed' : 'qr-loading'}>
              {qrFailed
                ? "Couldn't load the QR code — copy the link below instead."
                : 'Generating QR code…'}
            </span>
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
          <button className="btn-close-modal" ref={closeRef} onClick={onClose}>
            <CloseIcon />
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
