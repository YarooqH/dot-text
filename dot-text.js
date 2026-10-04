/*
 * dotText(canvas, options) -> { set, options, destroy, text, count }
 *
 * Draws text as a fixed number of dots. Every call to set() moves the same
 * dots into the new word, so no dot is ever created or thrown away.
 * No dependencies.
 *
 *   const dots = dotText(document.querySelector("canvas"), { count: 1200 });
 *   dots.set("hello");
 *   dots.set("world");
 */
function dotText(canvas, options) {
  const o = Object.assign({
    count: 1200,       // fixed for the life of the canvas
    font: '"Archivo Black", "Arial Black", sans-serif',
    weight: 400,
    shape: "circle",   // "circle" or "emoji" on a hex grid, or "square" pixels on a square grid
    emoji: "✨",       // for shape "emoji": one emoji, or several ("🍓🍒🍑") handed out to the dots in turn
    dot: null,         // dot size as a share of the grid spacing (0.5 = neighbors touch); defaults per shape
    padding: 0.1,      // clear space around the text, as a share of the shorter side
    duration: 1000,    // flight time of one dot, in ms
    stagger: 450,      // spread of start times across the word, in ms
    arc: 0.3,          // how far paths bow sideways, as a share of the distance
    mode: "flow",      // "flow" keeps neighbors together, "swarm" shuffles every dot
    color: "#111",
    accent: "#3355ff", // color of a dot mid-flight
    pointer: true,     // dots move aside for the cursor
    onTick: null,      // receives the number of dots in flight whenever it changes
  }, options);

  const N = o.count;
  const TAU = Math.PI * 2;
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas");
  const g = off.getContext("2d", { willReadFrequently: true });
  const buf = () => new Float32Array(N);
  const x = buf(), y = buf(), r = buf();                // position and radius now
  const ax = buf(), ay = buf(), ar = buf();             // flight start
  const bx = buf(), by = buf(), br = buf();             // flight end
  const kx = buf(), ky = buf(), wait = buf();           // curve control point, start delay
  const ox = buf(), oy = buf(), vx = buf(), vy = buf(); // push from the cursor
  const heat = new Uint8Array(N);                       // 0 at rest, 4 at mid-flight
  const hover = { x: 0, y: 0, on: false };
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let W = 0, H = 0, dpr = 1, text = null, t0 = 0, dur = 0, end = 0;
  let flying = false, raf = 0, reported = -1, shades = [], sprites = [];

  const share = () => o.dot != null ? o.dot : o.shape === "square" ? 0.42 : o.shape === "emoji" ? 0.5 : 0.34;

  // Emoji can't join a shared path like circles and squares, so each one is drawn once
  // into a small canvas and stamped with drawImage. Dots keep their emoji while they fly.
  function stamp() {
    const SIZE = 48;
    const list = typeof Intl !== "undefined" && Intl.Segmenter
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(String(o.emoji))].map((s) => s.segment)
      : Array.from(String(o.emoji));
    sprites = list.filter((s) => s.trim()).map((glyph) => {
      const c = document.createElement("canvas");
      c.width = c.height = SIZE;
      const s = c.getContext("2d");
      s.font = `${SIZE * 0.82}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      s.textBaseline = "alphabetic";
      const m = s.measureText(glyph);
      s.fillText(glyph,
        SIZE / 2 + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2,
        SIZE / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
      return c;
    });
  }

  function rgb(c) {
    g.fillStyle = "#000";
    g.fillStyle = c;
    const v = g.fillStyle;
    return v[0] === "#"
      ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))
      : v.match(/[\d.]+/g).slice(0, 3).map(Number);
  }

  // Five steps from the resting color to the accent, indexed by heat.
  function paint() {
    const a = rgb(o.color), b = rgb(o.accent);
    shades = [0, 1, 2, 3, 4].map((k) =>
      `rgb(${a.map((v, i) => Math.round(v + ((b[i] - v) * k) / 4)).join(",")})`);
  }

  // Where the N dots sit to spell `str` at the current canvas size.
  // The word is drawn once offscreen, then a hex grid is laid over it and its
  // spacing tuned until as close to N points as possible land on the letters.
  function place(str) {
    const S = Math.min(1, 1000 / W);
    const w = Math.max(2, Math.round(W * S)), h = Math.max(2, Math.round(H * S));
    const px = new Float32Array(N), py = new Float32Array(N), pr = new Float32Array(N);
    const pts = [];
    const square = o.shape === "square", rowStep = square ? 1 : 0.8660254;
    let gap = 0;

    if (str.trim()) {
      off.width = w;
      off.height = h;
      const pad = Math.min(w, h) * o.padding;
      g.font = `${o.weight} 100px ${o.font}`;
      let m = g.measureText(str);
      const size = 100 * Math.min(
        (w - 2 * pad) / ((m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || m.width || 1),
        (h - 2 * pad) / ((m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 72));
      g.font = `${o.weight} ${Math.max(1, size)}px ${o.font}`;
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      g.fillStyle = "#000";
      m = g.measureText(str);
      // center the ink, not the advance box, so descenders and side bearings don't skew it
      g.fillText(str,
        (w - m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2 + m.actualBoundingBoxLeft,
        (h - m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 + m.actualBoundingBoxAscent);

      const alpha = g.getImageData(0, 0, w, h).data;
      let area = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      for (let j = 0, p = 3; j < h; j++) {
        for (let i = 0; i < w; i++, p += 4) {
          if (alpha[p] > 127) {
            area++;
            if (i < x0) x0 = i;
            if (i > x1) x1 = i;
            if (j < y0) y0 = j;
            if (j > y1) y1 = j;
          }
        }
      }

      if (area) {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        // Count (and optionally collect) hex grid points with spacing s that land on ink.
        const grid = (s, out) => {
          const rh = s * rowStep;
          let n = 0;
          for (let j = Math.floor((y0 - cy) / rh); cy + j * rh <= y1; j++) {
            const yy = cy + j * rh;
            if (yy < 0 || yy >= h) continue;
            const row = (yy | 0) * w, shift = square || !(j & 1) ? 0 : s / 2;
            for (let i = Math.floor((x0 - cx - shift) / s); cx + shift + i * s <= x1; i++) {
              const xx = cx + shift + i * s;
              if (xx < 0 || xx >= w || alpha[(row + (xx | 0)) * 4 + 3] <= 127) continue;
              n++;
              if (out) out.push(xx, yy);
            }
          }
          return n;
        };
        const guess = Math.sqrt(area / N / rowStep);
        let lo = guess * 0.4, hi = guess * 2.5;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) / 2;
          if (grid(mid) > N) lo = mid;
          else hi = mid;
        }
        // counts wobble as the grid slides over the glyphs, so try a few nearby spacings
        gap = hi;
        let best = grid(hi);
        for (let k = 1; k <= 16; k++) {
          const s = hi * (1 - k * 0.001), n = grid(s);
          if (n <= N && n > best) { best = n; gap = s; }
        }
        grid(gap, pts);
      }
    }

    const M = pts.length / 2;
    if (M) {
      const rad = (gap / S) * share();
      for (let i = 0; i < N; i++) {
        // any dots left over stack on points spread evenly through the word
        const j = i < M ? i : Math.floor(((i - M + 0.5) * M) / (N - M)) % M;
        px[i] = pts[j * 2] / S;
        py[i] = pts[j * 2 + 1] / S;
        pr[i] = rad;
      }
    } else {
      // no text: the dots gather into a short line, like a cursor waiting for input
      const len = Math.min(W * 0.3, 260);
      for (let i = 0; i < N; i++) {
        px[i] = W / 2 + (i / (N - 1) - 0.5) * len;
        py[i] = H / 2;
        pr[i] = 1;
      }
    }
    return { px, py, pr };
  }

  // Match every dot to a target. "flow" sorts both sets left to right, cuts them
  // into thin strips and matches top to bottom inside each strip, so dots that
  // start as neighbors land as neighbors.
  function match(px, py) {
    const to = new Int32Array(N);
    const ids = () => Array.from({ length: N }, (_, i) => i);
    if (o.mode === "swarm") {
      const p = ids();
      for (let i = N - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [p[i], p[j]] = [p[j], p[i]];
      }
      p.forEach((t, i) => (to[i] = t));
      return to;
    }
    const a = ids().sort((i, j) => x[i] - x[j] || y[i] - y[j]);
    const b = ids().sort((i, j) => px[i] - px[j] || py[i] - py[j]);
    const strip = Math.max(4, Math.round(Math.sqrt(N)));
    for (let s = 0; s < N; s += strip) {
      const as = a.slice(s, s + strip).sort((i, j) => y[i] - y[j]);
      const bs = b.slice(s, s + strip).sort((i, j) => py[i] - py[j]);
      as.forEach((d, k) => (to[d] = bs[k]));
    }
    return to;
  }

  function fly(t) {
    const to = match(t.px, t.py);
    const still = calm.matches;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) {
      if (t.px[i] < lo) lo = t.px[i];
      if (t.px[i] > hi) hi = t.px[i];
    }
    dur = still ? 200 : o.duration;
    end = 0;
    for (let i = 0; i < N; i++) {
      const j = to[i];
      ax[i] = x[i]; ay[i] = y[i]; ar[i] = r[i];
      bx[i] = t.px[j]; by[i] = t.py[j]; br[i] = t.pr[j];
      const dx = bx[i] - ax[i], dy = by[i] - ay[i];
      const bend = still ? 0 : (Math.random() * 2 - 1) * o.arc * (o.mode === "swarm" ? 2.5 : 1);
      kx[i] = (ax[i] + bx[i]) / 2 - dy * bend;
      ky[i] = (ay[i] + by[i]) / 2 + dx * bend;
      const u = (bx[i] - lo) / (hi - lo || 1);
      wait[i] = still ? 0 : o.stagger * (o.mode === "swarm" ? Math.random() : u * 0.8 + Math.random() * 0.2);
      if (wait[i] > end) end = wait[i];
    }
    end += dur;
    t0 = performance.now();
    flying = true;
    wake();
  }

  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  function frame(now) {
    raf = 0;
    let moving = 0, restless = false;

    if (flying) {
      const t = now - t0;
      for (let i = 0; i < N; i++) {
        const p = Math.min(1, Math.max(0, (t - wait[i]) / dur));
        const e = ease(p), q = 1 - e, lift = Math.sin(Math.PI * p);
        x[i] = q * q * ax[i] + 2 * q * e * kx[i] + e * e * bx[i];
        y[i] = q * q * ay[i] + 2 * q * e * ky[i] + e * e * by[i];
        r[i] = (ar[i] + (br[i] - ar[i]) * e) * (1 - 0.3 * lift);
        heat[i] = Math.round(lift * 4);
        if (p > 0 && p < 1) moving++;
      }
      if (t >= end) flying = false;
    }

    if (o.pointer) {
      const R = Math.max(50, Math.min(W, H) * 0.16), R2 = R * R;
      for (let i = 0; i < N; i++) {
        if (hover.on) {
          const dx = x[i] + ox[i] - hover.x, dy = y[i] + oy[i] - hover.y, d2 = dx * dx + dy * dy;
          if (d2 < R2 && d2 > 1e-4) {
            const d = Math.sqrt(d2), f = 1 - d / R, k = (4 * f * f) / d;
            vx[i] += dx * k;
            vy[i] += dy * k;
          }
        }
        vx[i] = (vx[i] - ox[i] * 0.06) * 0.84;
        vy[i] = (vy[i] - oy[i] * 0.06) * 0.84;
        ox[i] += vx[i];
        oy[i] += vy[i];
        if (!restless && (vx[i] * vx[i] + vy[i] * vy[i] > 1e-3 || ox[i] * ox[i] + oy[i] * oy[i] > 1e-2)) restless = true;
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (o.shape === "emoji" && sprites.length) {
      for (let i = 0; i < N; i++) {
        if (r[i] < 0.2) continue;
        const d = r[i] * 2;
        ctx.drawImage(sprites[i % sprites.length], x[i] + ox[i] - r[i], y[i] + oy[i] - r[i], d, d);
      }
    }
    const square = o.shape === "square";
    for (let k = 0; o.shape !== "emoji" && k < 5; k++) {
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        if (heat[i] !== k || r[i] < 0.2) continue;
        const cx = x[i] + ox[i], cy = y[i] + oy[i];
        if (square) {
          ctx.rect(cx - r[i], cy - r[i], r[i] * 2, r[i] * 2);
        } else {
          ctx.moveTo(cx + r[i], cy);
          ctx.arc(cx, cy, r[i], 0, TAU);
        }
        any = true;
      }
      if (any) {
        ctx.fillStyle = shades[k];
        ctx.fill();
      }
    }

    if (o.onTick && moving !== reported) o.onTick((reported = moving));
    if (flying || restless || hover.on) wake();
  }

  function wake() {
    if (!raf && W) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const box = canvas.getBoundingClientRect();
    const w = Math.round(box.width), h = Math.round(box.height);
    if (!w || !h || (w === W && h === H)) return;
    const first = !W;
    W = w;
    H = h;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (first) {
      // start as loose dust across the canvas, then fly into the first word
      for (let i = 0; i < N; i++) {
        x[i] = Math.random() * W;
        y[i] = Math.random() * H;
        r[i] = 0.8;
      }
      if (text !== null) fly(place(text));
    } else if (text !== null) {
      // a resize snaps the dots into the refitted word instead of replaying the flight
      const t = place(text), to = match(t.px, t.py);
      for (let i = 0; i < N; i++) {
        const j = to[i];
        x[i] = t.px[j]; y[i] = t.py[j]; r[i] = t.pr[j];
        heat[i] = 0;
      }
      flying = false;
    }
    wake();
  }

  function point(e) {
    if (!o.pointer) return;
    const box = canvas.getBoundingClientRect();
    hover.x = e.clientX - box.left;
    hover.y = e.clientY - box.top;
    hover.on = true;
    wake();
  }
  function leave() {
    hover.on = false;
    wake();
  }
  function release(e) {
    if (e.pointerType !== "mouse") leave();
  }

  canvas.addEventListener("pointermove", point);
  canvas.addEventListener("pointerdown", point);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("pointercancel", leave);
  canvas.addEventListener("pointerup", release);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  paint();
  stamp();
  resize();

  const api = {
    count: N,
    get text() {
      return text;
    },
    set(str) {
      text = String(str == null ? "" : str);
      if (W) fly(place(text));
      return api;
    },
    // change any option except count; new motion settings apply to the next set().
    // A new shape refits the word right away; a new dot size resizes the dots in place.
    options(patch) {
      const before = share();
      Object.assign(o, patch);
      if ("color" in patch || "accent" in patch) paint();
      if ("emoji" in patch) stamp();
      if ("shape" in patch && text !== null && W) {
        fly(place(text));
      } else if ("dot" in patch) {
        const k = share() / before;
        for (let i = 0; i < N; i++) {
          r[i] *= k;
          ar[i] *= k;
          br[i] *= k;
        }
      }
      wake();
      return api;
    },
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", point);
      canvas.removeEventListener("pointerdown", point);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointercancel", leave);
      canvas.removeEventListener("pointerup", release);
    },
  };
  return api;
}

if (typeof module !== "undefined") module.exports = dotText;
