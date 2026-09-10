import { useEffect, useRef } from 'react';

/**
 * The animated backdrop: a topographic survey that redraws itself, live.
 *
 * This is a map application, so the backdrop is a map. A scalar elevation
 * field is built from a handful of slowly drifting peaks, and every frame the
 * contour lines are re-traced through it with marching squares — the same
 * method a real contour plot uses. The lines are therefore not a looping
 * animation of a drawing; they are the actual isolines of a landscape that is
 * moving underneath them, which is why they merge, split and pinch off the
 * way contours on a survey sheet do.
 *
 * The cursor is itself a peak. Moving it raises ground under the pointer and
 * the isolines bend around it in real time, with the peak trailing slightly
 * behind on a spring so the terrain has weight.
 *
 * Every fifth line is drawn heavier. That is the index-contour convention
 * from real topographic maps, and it is most of why this reads as a surveyed
 * drawing rather than as a generated ripple.
 */

const GRID_SPACING = 15;      // px between field samples; smaller = finer lines
const LEVELS = 30;            // contour lines, spread across the field's real range
const INDEX_EVERY = 5;        // every Nth contour is an index line
const POINTER_AMPLITUDE = 62; // how high the cursor lifts the ground
const POINTER_SIGMA = 165;    // px; the footprint of the cursor's hill
const POINTER_EASE = 14;      // per second. Faster than the eye: at 1500px/s the
                              // hill trails ~107px, inside its own 165px sigma,
                              // so the cursor stays on the ground it raises.
const MAX_DT = 1 / 30;

// Drifting peaks, in normalised coordinates so a resize rescales them. Slow,
// incommensurate periods: the composition never returns to the same state.
const PEAKS = [
  { hx: 0.18, hy: 0.24, amp: 96, sigma: 0.30, sx: 0.275, sy: 0.205, rx: 0.13, ry: 0.10 },
  { hx: 0.78, hy: 0.18, amp: -74, sigma: 0.26, sx: 0.185, sy: 0.310, rx: 0.11, ry: 0.14 },
  { hx: 0.68, hy: 0.72, amp: 88, sigma: 0.32, sx: 0.240, sy: 0.165, rx: 0.15, ry: 0.11 },
  { hx: 0.26, hy: 0.80, amp: -66, sigma: 0.24, sx: 0.145, sy: 0.265, rx: 0.10, ry: 0.13 },
  { hx: 0.48, hy: 0.46, amp: 58, sigma: 0.38, sx: 0.305, sy: 0.135, rx: 0.17, ry: 0.09 },
];

export default function ContourField() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return undefined;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let field = new Float32Array(0);
    let spacing = GRID_SPACING;
    let fieldMin = 0;
    let fieldMax = 0;
    let frame = null;
    let last = performance.now();
    let elapsed = 0;

    // The cursor's hill: `target` is where the pointer is, `current` trails it.
    const hill = { tx: 0, ty: 0, x: 0, y: 0, strength: 0, targetStrength: 0 };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (!width || !height) return;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // A coarser grid on small screens: fewer samples, same drawing.
      spacing = width < 700 ? GRID_SPACING * 1.5 : GRID_SPACING;
      cols = Math.ceil(width / spacing) + 1;
      rows = Math.ceil(height / spacing) + 1;
      field = new Float32Array(cols * rows);
    };

    const sampleField = () => {
      const shortest = Math.min(width, height);

      // Resolve each drifting peak to pixel space once per frame, rather than
      // recomputing its position inside the per-cell loop.
      const peaks = PEAKS.map((p) => {
        const px = (p.hx + Math.sin(elapsed * p.sx) * p.rx) * width;
        const py = (p.hy + Math.cos(elapsed * p.sy) * p.ry) * height;
        const sigma = p.sigma * shortest;
        return { px, py, amp: p.amp, inv: 1 / (sigma * sigma) };
      });

      const hillInv = 1 / (POINTER_SIGMA * POINTER_SIGMA);
      const hillAmp = POINTER_AMPLITUDE * hill.strength;

      // The field's range is whatever the peaks happen to sum to — it drifts,
      // and the cursor's hill widens it further. Measuring it here, rather
      // than assuming a fixed span, is what keeps every contour level inside
      // the data: pick a span by hand and most of the levels fall outside the
      // field and draw nothing at all.
      let min = Infinity;
      let max = -Infinity;

      for (let row = 0; row < rows; row++) {
        const y = row * spacing;
        for (let col = 0; col < cols; col++) {
          const x = col * spacing;
          let value = 0;

          for (let i = 0; i < peaks.length; i++) {
            const p = peaks[i];
            const dx = x - p.px;
            const dy = y - p.py;
            // Inverse-quadratic falloff rather than a Gaussian: the shape is
            // indistinguishable at this scale and it avoids ~100k exp() calls
            // per frame.
            value += p.amp / (1 + (dx * dx + dy * dy) * p.inv);
          }

          if (hillAmp !== 0) {
            const dx = x - hill.x;
            const dy = y - hill.y;
            value += hillAmp / (1 + (dx * dx + dy * dy) * hillInv);
          }

          field[row * cols + col] = value;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }

      fieldMin = min;
      fieldMax = max;
    };

    /**
     * Marching squares for one contour level.
     *
     * Each cell's four corners are classified above/below the level, giving 16
     * possible configurations. The crossing points are linearly interpolated
     * along the edges, which is what makes the lines smooth instead of
     * stair-stepped.
     */
    // Scratch values for the four possible edge crossings. Hoisted out of the
    // loop: this runs ~100k times a frame across all levels, and allocating a
    // closure or a point array per cell would mean millions of short-lived
    // objects per second for the collector to deal with.
    let ax = 0, ay = 0, bx = 0, by = 0;

    const buildLevelPath = (level, spacing) => {
      ctx.beginPath();

      for (let row = 0; row < rows - 1; row++) {
        const y = row * spacing;
        const rowOffset = row * cols;

        for (let col = 0; col < cols - 1; col++) {
          const i = rowOffset + col;
          const tl = field[i];
          const tr = field[i + 1];
          const br = field[i + cols + 1];
          const bl = field[i + cols];

          let state = 0;
          if (tl > level) state |= 8;
          if (tr > level) state |= 4;
          if (br > level) state |= 2;
          if (bl > level) state |= 1;
          // The overwhelming majority of cells are entirely above or entirely
          // below the level and are rejected right here.
          if (state === 0 || state === 15) continue;

          const x = col * spacing;

          // Linear interpolation along each edge is what makes the line smooth
          // instead of stair-stepped. The guards cover the degenerate case
          // where both corners sit exactly on the level.
          let d;
          // top edge
          d = tr - tl;
          const topX = x + (d === 0 ? 0.5 : (level - tl) / d) * spacing;
          // right edge
          d = br - tr;
          const rightY = y + (d === 0 ? 0.5 : (level - tr) / d) * spacing;
          // bottom edge
          d = br - bl;
          const bottomX = x + (d === 0 ? 0.5 : (level - bl) / d) * spacing;
          // left edge
          d = bl - tl;
          const leftY = y + (d === 0 ? 0.5 : (level - tl) / d) * spacing;

          const right = x + spacing;
          const bottom = y + spacing;

          switch (state) {
            case 1: case 14: ax = x; ay = leftY; bx = bottomX; by = bottom; break;
            case 2: case 13: ax = bottomX; ay = bottom; bx = right; by = rightY; break;
            case 3: case 12: ax = x; ay = leftY; bx = right; by = rightY; break;
            case 4: case 11: ax = topX; ay = y; bx = right; by = rightY; break;
            case 6: case 9:  ax = topX; ay = y; bx = bottomX; by = bottom; break;
            case 7: case 8:  ax = x; ay = leftY; bx = topX; by = y; break;

            // Saddles: the cell holds two separate curves. Which pair of
            // corners connects is decided by the average of the four, so the
            // choice follows the surface instead of being an arbitrary
            // convention that can make contours cross.
            case 5: {
              if ((tl + tr + br + bl) / 4 > level) {
                ctx.moveTo(x, leftY); ctx.lineTo(topX, y);
                ctx.moveTo(bottomX, bottom); ctx.lineTo(right, rightY);
              } else {
                ctx.moveTo(x, leftY); ctx.lineTo(bottomX, bottom);
                ctx.moveTo(topX, y); ctx.lineTo(right, rightY);
              }
              continue;
            }
            case 10: {
              if ((tl + tr + br + bl) / 4 > level) {
                ctx.moveTo(x, leftY); ctx.lineTo(bottomX, bottom);
                ctx.moveTo(topX, y); ctx.lineTo(right, rightY);
              } else {
                ctx.moveTo(x, leftY); ctx.lineTo(topX, y);
                ctx.moveTo(bottomX, bottom); ctx.lineTo(right, rightY);
              }
              continue;
            }
            default: continue;
          }

          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = 'round';

      // Levels span the field's measured range, so every one of them lands in
      // the data and draws. The endpoints are excluded: a contour exactly at
      // the minimum or maximum degenerates to a point.
      const range = fieldMax - fieldMin;
      if (range < 1e-3) return;

      const stepSize = range / (LEVELS + 1);

      for (let i = 1; i <= LEVELS; i++) {
        const level = fieldMin + i * stepSize;
        const isIndex = i % INDEX_EVERY === 0;

        // Contours nearest the summits and hollows are tiny closed rings;
        // easing them back keeps the drawing from pooling into dark knots at
        // the extremes while the broad mid-slope lines stay full strength.
        // Measured from the range, not from zero — the field is not centred
        // on zero and assuming it was faded out precisely the densest region.
        const position = (i / (LEVELS + 1)) * 2 - 1;
        const fade = 1 - position * position * 0.72;

        const alpha = (isIndex ? 0.26 : 0.115) * fade;

        // Two passes per line: a wide, near-invisible one for the halo ink
        // bleeds into paper, then the crisp line on top. A single hairline
        // reads as vector output; the bleed is most of what makes it read as
        // something that was printed.
        // Index lines are engraved: a light line offset down-right, drawn
        // first so the ink sits on top of it. That pairing — highlight below,
        // dark line above — is what the eye reads as a groove pressed into
        // paper. Only the index contours carry it; a real survey sheet
        // emphasises those lines too, and it keeps the extra path build off
        // the other 24.
        //
        // The offset is applied to the transform before the path is built,
        // because a Canvas2D path stores the coordinates it was given — moving
        // the transform afterwards would move the pen, not the line.
        if (isIndex) {
          ctx.save();
          ctx.translate(1, 1.2);
          buildLevelPath(level, spacing);
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.95 * fade})`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.restore();
        }

        // The path is traced once and stroked twice — the marching-squares
        // pass is the expensive half, and both strokes want the same geometry.
        buildLevelPath(level, spacing);

        ctx.strokeStyle = `rgba(31, 45, 56, ${alpha * 0.28})`;
        ctx.lineWidth = isIndex ? 3.4 : 2.4;
        ctx.stroke();

        ctx.strokeStyle = `rgba(31, 45, 56, ${alpha})`;
        ctx.lineWidth = isIndex ? 1.2 : 0.8;
        ctx.stroke();
      }
    };

    const step = (now) => {
      const dt = Math.min((now - last) / 1000, MAX_DT);
      last = now;
      elapsed += dt;

      // Exponential smoothing written in terms of dt, so the terrain settles
      // at the same rate regardless of whether the display runs at 60 or 120Hz.
      const k = 1 - Math.exp(-POINTER_EASE * dt);
      hill.x += (hill.tx - hill.x) * k;
      hill.y += (hill.ty - hill.y) * k;
      hill.strength += (hill.targetStrength - hill.strength) * k;

      sampleField();
      draw();
      frame = requestAnimationFrame(step);
    };

    const start = () => {
      if (frame === null && !reduceMotion.matches && !document.hidden) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };

    const stop = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    // Held still for reduced motion, but still drawn — the composition is
    // information about the product's character, the movement is not.
    const drawStatic = () => {
      sampleField();
      draw();
    };

    const onResize = () => {
      resize();
      if (!width || !height) return;
      // A resize reallocates the backing store, which clears it. With no loop
      // running there is nothing to repaint it, so do it here.
      if (reduceMotion.matches || document.hidden) drawStatic();
    };

    const onPointerMove = (event) => {
      hill.tx = event.clientX;
      hill.ty = event.clientY;
      if (hill.targetStrength === 0) {
        // First contact: start the hill where the cursor is, so it rises in
        // place rather than sliding in from the corner.
        hill.x = event.clientX;
        hill.y = event.clientY;
      }
      hill.targetStrength = 1;
    };

    // Touch taps leave the pointer somewhere arbitrary; without this the hill
    // would stay raised under wherever the finger last was.
    const onPointerGone = () => {
      hill.targetStrength = 0;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onMotionPreference = () => {
      stop();
      if (reduceMotion.matches) drawStatic();
      else start();
    };

    resize();
    drawStatic();
    start();

    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointercancel', onPointerGone);
    window.addEventListener('touchend', onPointerGone, { passive: true });
    document.addEventListener('pointerleave', onPointerGone);
    document.addEventListener('visibilitychange', onVisibility);
    reduceMotion.addEventListener('change', onMotionPreference);

    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointercancel', onPointerGone);
      window.removeEventListener('touchend', onPointerGone);
      document.removeEventListener('pointerleave', onPointerGone);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onMotionPreference);
    };
  }, []);

  return <canvas ref={canvasRef} className="contour-field" aria-hidden="true" />;
}
