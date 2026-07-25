/* Live hero road — a JS port of the game's own renderer (Renderer.draw in
   Theme.swift) and biome crossfade (Biome.swift). Same projection constants:
   scale = (1 - t*0.62) * (w/150), 24 sampled rows, neon = halo + core + white
   inner stroke. Scrolling the page steers the car — the scroll wheel is the
   desktop's Digital Crown. */

(function () {
  const canvas = document.getElementById("road");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- Biome palettes, verbatim from Biome.swift (0–255) -------------------
  const BIOMES = [
    { // sunset
      bgTop: [10, 5, 26], bgBottom: [26, 5, 41],
      edge: [51, 255, 242], center: [255, 64, 217],
    },
    { // midnight
      bgTop: [3, 5, 20], bgBottom: [5, 13, 38],
      edge: [140, 217, 255], center: [153, 89, 255],
    },
    { // dawn
      bgTop: [33, 8, 31], bgBottom: [77, 33, 10],
      edge: [77, 255, 209], center: [255, 56, 140],
    },
  ];
  const CYCLE = 1500, FADE = 150;           // Biome.cycle / Biome.fade
  const LIME = [140, 255, 89], GOLD = [255, 230, 64], RED = [255, 77, 89];

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpRGB(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }
  function css(c, alpha) {
    return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + (alpha === undefined ? 1 : alpha) + ")";
  }
  // Biome.palette(at:) — hold, then crossfade over the last FADE units.
  function paletteAt(s) {
    const idx = Math.floor(Math.max(0, s) / CYCLE);
    const cur = BIOMES[idx % 3], nxt = BIOMES[(idx + 1) % 3];
    const into = Math.max(0, s) - idx * CYCLE;
    if (into >= CYCLE - FADE) {
      const t = (into - (CYCLE - FADE)) / FADE;
      return {
        bgTop: lerpRGB(cur.bgTop, nxt.bgTop, t),
        bgBottom: lerpRGB(cur.bgBottom, nxt.bgBottom, t),
        edge: lerpRGB(cur.edge, nxt.edge, t),
        center: lerpRGB(cur.center, nxt.center, t),
      };
    }
    return cur;
  }

  // --- Road + world ---------------------------------------------------------
  const VIEW_DEPTH = 420, ROWS = 24, HALF_W = 40, SPEED = 150;
  function roadCenter(s) {
    return 24 * Math.sin(s * 0.011) + 13 * Math.sin(s * 0.0047 + 2.1);
  }

  // Deterministic per-row hash for ambient traffic/coins (uniform integer
  // xorshift — no RNG, so every visitor sees the same road).
  function hash(n) {
    let x = n | 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  const ROW_GAP = 95;
  function rowEntity(rowIndex) {
    const h = hash(rowIndex * 3);
    if (h < 0.30) {
      return { kind: "car", lane: (hash(rowIndex * 3 + 1) - 0.5) * 1.4, weave: h < 0.12 };
    }
    if (h < 0.55) {
      return { kind: "coin", lane: (hash(rowIndex * 3 + 2) - 0.5) * 1.3 };
    }
    return null;
  }

  // --- State ----------------------------------------------------------------
  // Start where the row hash puts a car and a coin in the opening frame; offset
  // the palette so the first impression is still early-sunset (the title-screen
  // look), with the midnight crossfade arriving ~9s in.
  const PALETTE_OFFSET = 1300;
  let dist = 1340;
  let steer = 0, steerV = 0;      // scroll-driven lateral offset (world units)
  let lastScrollY = window.scrollY;
  let running = !reduceMotion, visible = true, inView = true;
  let W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!running) draw(0);
  }

  // --- Neon strokes: halo pass + core + near-white inner (Renderer.neonStroke)
  function neonPath(points, color, width) {
    if (points.length < 2) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const passes = [
      [width * 3.2, 0.16], [width * 1.8, 0.42], [width, 1.0],
    ];
    for (const [w, a] of passes) {
      ctx.strokeStyle = css(color, a);
      ctx.lineWidth = w;
      strokePoly(points);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, width * 0.35);
    strokePoly(points);
  }
  function strokePoly(points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.stroke();
  }
  function neonDisc(x, y, r, color) {
    ctx.fillStyle = css(color, 0.25);
    ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
    ctx.fillStyle = css(color, 1);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, 7); ctx.fill();
  }
  function neonCar(x, y, scale, color) {
    const w = 15 * scale, h = 21 * scale, r = 3.5 * scale;
    ctx.save();
    const passes = [
      [Math.max(1, 4.5 * scale), 0.18], [Math.max(1, 2.6 * scale), 0.5], [Math.max(1, 1.8 * scale), 1],
    ];
    for (const [lw, a] of passes) {
      ctx.strokeStyle = css(color, a);
      ctx.lineWidth = lw;
      roundRectPath(x - w / 2, y - h / 2, w, h, r);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = Math.max(0.6, 0.7 * scale);
    roundRectPath(x - w / 2, y - h / 2, w, h, r);
    ctx.stroke();
    ctx.restore();
  }
  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // --- Frame ------------------------------------------------------------------
  function draw(dt) {
    const pal = paletteAt(dist - PALETTE_OFFSET);
    const originCenter = roadCenter(dist);
    const midX = W / 2;

    // bg gradient (bgTop -> bgBottom), exactly like the game
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, css(pal.bgTop));
    g.addColorStop(1, css(pal.bgBottom));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Renderer.draw's projection: near = wide, far = narrow
    function project(worldX, t) {
      const scale = (1 - t * 0.62) * (W / 150);
      return [midX + (worldX - originCenter) * scale * 0.62, H * (1 - t)];
    }

    // road edges + dashed center line, sampled over ROWS
    const left = [], right = [];
    const dashes = [];
    for (let i = 0; i <= ROWS; i++) {
      const t = i / ROWS;
      const s = dist + t * VIEW_DEPTH;
      const c = roadCenter(s);
      left.push(project(c - HALF_W, t));
      right.push(project(c + HALF_W, t));
      if (i % 2 === 0 && i < ROWS) {
        const t2 = (i + 1) / ROWS;
        dashes.push([project(c, t), project(roadCenter(dist + t2 * VIEW_DEPTH), t2)]);
      }
    }
    neonPath(left, pal.edge, 2.6);
    neonPath(right, pal.edge, 2.6);
    for (const d of dashes) neonPath(d, pal.center, 1.8);

    // ambient coins + traffic from the deterministic row hash
    const firstRow = Math.ceil(dist / ROW_GAP);
    const lastRow = Math.floor((dist + VIEW_DEPTH) / ROW_GAP);
    for (let row = lastRow; row >= firstRow; row--) {   // far-to-near
      const e = rowEntity(row);
      if (!e) continue;
      const s = row * ROW_GAP;
      const t = (s - dist) / VIEW_DEPTH;
      if (t <= 0.02) continue;
      let lane = e.lane;
      if (e.weave) lane += 0.25 * Math.sin(s * 0.015);   // weavers sway with distance
      const x = roadCenter(s) + lane * (HALF_W - 10);
      const p = project(x, t);
      if (e.kind === "coin") {
        neonDisc(p[0], p[1], Math.max(1.6, 6 * (1 - t)), GOLD);
      } else {
        neonCar(p[0], p[1], (1 - t), RED);
      }
    }

    // player car near the bottom, nudged by scroll-steer (t = 0.06 in the game;
    // 0.10 here so it clears the scroll hint)
    const carT = 0.10;
    const carX = roadCenter(dist + carT * VIEW_DEPTH) + steer;
    const p = project(carX, carT);
    neonCar(p[0], p[1], 1, LIME);

    // advance world
    dist += SPEED * dt;
    steer += steerV * dt;
    steerV *= Math.pow(0.02, dt);            // scroll impulse decays fast
    steer *= Math.pow(0.25, dt);             // car eases back to the road center
    const maxSteer = HALF_W - 8;
    if (steer > maxSteer) steer = maxSteer;
    if (steer < -maxSteer) steer = -maxSteer;
  }

  // --- Loop -------------------------------------------------------------------
  let last = null;
  function frame(now) {
    if (!running || !visible || !inView) { last = null; return; }
    if (last === null) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    draw(dt);
    requestAnimationFrame(frame);
  }
  function wake() {
    if (running && visible && inView && last === null) requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    wake();
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      inView = entries[0].isIntersecting;
      wake();
    }).observe(canvas);
  }

  // scroll = crown: steer the car and spin the mockup's crown ridges
  if (!reduceMotion) {
    window.addEventListener("scroll", () => {
      const dy = window.scrollY - lastScrollY;
      lastScrollY = window.scrollY;
      steerV += dy * 2.2;
      document.documentElement.style.setProperty("--crown-shift", (window.scrollY * -0.35) + "px");
    }, { passive: true });
  }

  window.addEventListener("resize", resize);
  resize();
  if (running) requestAnimationFrame(frame);
  else draw(0);   // reduced motion: one static frame
})();
