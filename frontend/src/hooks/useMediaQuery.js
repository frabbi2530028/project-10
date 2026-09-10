import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query from JS.
 *
 * Needed where a decision has to be made in markup rather than in the
 * stylesheet — `inert` on the mobile controls sheet is the case here, because
 * whether the sheet is a closable sheet at all depends on the same breakpoint
 * the CSS uses, and CSS cannot set an attribute.
 *
 * Initialised from a real match rather than from `false`, so the first paint
 * is correct instead of flipping on the first effect.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);

    // Re-read on subscribe: the viewport can change between the initial state
    // and this effect running.
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
