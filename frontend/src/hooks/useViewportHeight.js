import { useEffect } from 'react';

/**
 * Keeps the --app-height CSS variable equal to the *visible* viewport height.
 *
 * Needed because iOS Safari's `100vh` resolves to the tallest possible
 * viewport (with the toolbars hidden), so a 100vh layout is taller than what
 * you can actually see and the page scrolls the top bar away. `100dvh` solves
 * this on iOS 16+, but older iPhones don't support it — this keeps those
 * working too, and stays correct as Safari's toolbars expand and collapse.
 *
 * visualViewport is the accurate source where available (it accounts for the
 * on-screen keyboard and pinch-zoom); innerHeight is the fallback.
 */
export function useViewportHeight() {
  useEffect(() => {
    const apply = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
    };

    apply();

    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.visualViewport?.addEventListener('resize', apply);

    // Safari reports stale sizes right after an orientation change, so
    // re-apply once the rotation has settled.
    const onOrientation = () => setTimeout(apply, 300);
    window.addEventListener('orientationchange', onOrientation);

    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.removeEventListener('orientationchange', onOrientation);
      window.visualViewport?.removeEventListener('resize', apply);
    };
  }, []);
}
