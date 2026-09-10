import { AlertIcon, CrosshairIcon } from './Icons';

export default function LocationBanner({ hint, onEnableLocation }) {
  if (!hint.visible) return null;

  return (
    // Advisory rather than an error, so `polite`: it should be announced when
    // the reader next pauses, not cut across whatever it is already saying.
    <div id="loc-banner" role="status" aria-live="polite">
      <AlertIcon />
      <span id="loc-banner-text">{hint.text}</span>
      {hint.showButton && (
        <>
          <br />
          {/* Triggering the geolocation request from inside a real tap is the
              one path guaranteed to surface the iOS permission prompt. */}
          <button className="btn-enable-gps" onClick={onEnableLocation}>
            <CrosshairIcon />
            <span>Tap to Enable Location</span>
          </button>
        </>
      )}
    </div>
  );
}
