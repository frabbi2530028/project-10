import { useCallback, useEffect, useState } from 'react';

/**
 * Makes an element aware of the cursor, for effects CSS can then own.
 *
 * Writes four custom properties on the element as the pointer moves over it:
 *
 *   --px, --py           cursor position within the element, in %
 *   --tilt-x, --tilt-y   rotation in degrees, for a 3D lean
 *
 * Returns a *callback ref*, not an object ref. The element this attaches to is
 * usually rendered conditionally — behind a session check, a loading flag — so
 * it is not in the DOM on the first commit. An object ref would be null when
 * the effect ran, and with stable dependencies the effect would never run
 * again, leaving the properties frozen at their defaults forever. A callback
 * ref re-runs the setup at the moment the node actually attaches.
 *
 * Values are written straight to the node rather than kept in state: this
 * fires on every pointermove, and re-rendering React at pointer rate would
 * drop frames for no benefit.
 */
export function usePointerGlow({ maxTilt = 6, ease = 9 } = {}) {
  const [element, setElement] = useState(null);

  useEffect(() => {
    if (!element) return undefined;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Resting state: level, lit from the middle.
    const target = { px: 50, py: 50, tx: 0, ty: 0 };
    const current = { px: 50, py: 50, tx: 0, ty: 0 };
    let frame = null;

    // The element's box, cached. Reading it inside pointermove would force a
    // synchronous layout on every event, and once the card is tilting the
    // measured box changes with the rotation — which would feed back into the
    // position calculation and make the mapping jitter near the edges.
    let box = null;
    const measure = () => { box = element.getBoundingClientRect(); };

    const apply = () => {
      element.style.setProperty('--px', `${current.px.toFixed(2)}%`);
      element.style.setProperty('--py', `${current.py.toFixed(2)}%`);
      element.style.setProperty('--tilt-x', `${current.tx.toFixed(3)}deg`);
      element.style.setProperty('--tilt-y', `${current.ty.toFixed(3)}deg`);
    };

    let lastFrame = 0;

    const step = (now) => {
      // `ease` is a rate per second, converted to this frame's share. A raw
      // per-frame factor would make the card settle twice as fast on a 120Hz
      // display as on a 60Hz one.
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 1 / 30) : 1 / 60;
      lastFrame = now;
      const k = 1 - Math.exp(-ease * dt);

      let moving = false;
      for (const key of ['px', 'py', 'tx', 'ty']) {
        const delta = target[key] - current[key];
        if (Math.abs(delta) > 0.01) {
          current[key] += delta * k;
          moving = true;
        } else {
          current[key] = target[key];
        }
      }
      apply();

      if (moving) {
        frame = requestAnimationFrame(step);
      } else {
        // Idle: stop scheduling frames until the pointer moves again.
        frame = null;
        lastFrame = 0;
      }
    };

    const settle = () => {
      if (reduceMotion.matches) {
        // Easing a highlight across the card at 60fps is motion too, whatever
        // it is decorating. Snap straight to the value instead of gliding.
        Object.assign(current, target);
        apply();
        return;
      }
      if (frame === null) {
        lastFrame = 0;
        frame = requestAnimationFrame(step);
      }
    };

    const onPointerMove = (event) => {
      if (box === null) measure();
      if (!box.width || !box.height) return;

      const x = (event.clientX - box.left) / box.width;
      const y = (event.clientY - box.top) / box.height;

      target.px = x * 100;
      target.py = y * 100;

      if (!reduceMotion.matches && maxTilt > 0) {
        // Lean away from the cursor: the near edge lifts, the way a physical
        // card behaves when you press one side of it.
        target.ty = (x - 0.5) * 2 * maxTilt;
        target.tx = -(y - 0.5) * 2 * maxTilt;
      }
      settle();
    };

    const onPointerEnter = () => measure();

    const onPointerLeave = () => {
      target.px = 50;
      target.py = 50;
      target.tx = 0;
      target.ty = 0;
      settle();
    };

    // The cached box is only invalid when the layout itself moves.
    const invalidate = () => { box = null; };

    // The card grows when a validation error appears — no resize or scroll
    // event fires for that, so observe the element directly.
    const observer = new ResizeObserver(invalidate);
    observer.observe(element);

    apply();
    element.addEventListener('pointerenter', onPointerEnter);
    element.addEventListener('pointermove', onPointerMove, { passive: true });
    element.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, { passive: true });

    return () => {
      observer.disconnect();
      element.removeEventListener('pointerenter', onPointerEnter);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
  }, [element, maxTilt, ease]);

  // Stable identity, so attaching it doesn't detach-and-reattach every render.
  return useCallback((node) => setElement(node), []);
}
