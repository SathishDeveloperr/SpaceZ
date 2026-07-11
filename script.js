/* ============================================================
   SPACE Z — scroll engine
   Lenis + GSAP ScrollTrigger, dual canvas image-sequence acts
   ============================================================ */

gsap.registerPlugin(ScrollTrigger);

/* our 722 lazy-loaded frames delay window "load" until well after the
   intro animation has played; a refresh at that point re-renders scrub
   timelines and restores pre-intro element states — so refresh only on
   resize/visibility, never on load */
ScrollTrigger.config({ autoRefreshEvents: "visibilitychange,DOMContentLoaded,resize" });

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

/* ------------------------------------------------------------
   Text splitting (SplitText-lite)
   ------------------------------------------------------------ */
function splitChars(el) {
  const text = el.textContent;
  el.textContent = "";
  el.setAttribute("aria-label", text);
  const chars = [];
  for (const ch of text) {
    const s = document.createElement("span");
    s.className = "ch";
    s.setAttribute("aria-hidden", "true");
    s.textContent = ch;
    el.appendChild(s);
    chars.push(s);
  }
  return chars;
}

function splitLines(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.textContent = "";
  const spans = words.map((w) => {
    const s = document.createElement("span");
    s.textContent = w + " ";
    s.style.display = "inline-block";
    el.appendChild(s);
    return s;
  });
  // group words into lines by measured offsetTop
  const lines = [];
  let currentTop = null;
  let bucket = [];
  spans.forEach((s) => {
    const top = s.offsetTop;
    if (currentTop === null || Math.abs(top - currentTop) < 4) {
      bucket.push(s);
      if (currentTop === null) currentTop = top;
    } else {
      lines.push(bucket);
      bucket = [s];
      currentTop = top;
    }
  });
  if (bucket.length) lines.push(bucket);

  el.textContent = "";
  return lines.map((lineWords) => {
    const mask = document.createElement("span");
    mask.className = "line-mask";
    const inner = document.createElement("span");
    inner.className = "line-inner";
    inner.textContent = lineWords.map((w) => w.textContent).join("").trim();
    mask.appendChild(inner);
    el.appendChild(mask);
    return inner;
  });
}

/* ------------------------------------------------------------
   Frame sequence: preload + cover-draw on canvas
   ------------------------------------------------------------ */
class FrameSequence {
  constructor(canvas, { path, count, prefix = "f", pad = 4, ext = ".webp", overscan = 1 }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.path = path;
    this.count = count;
    this.prefix = prefix;
    this.pad = pad;
    this.ext = ext;
    this.overscan = overscan;
    this.images = new Array(count).fill(null);
    this.current = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.resize();
    window.addEventListener("resize", () => { this.resize(); this.draw(this.current); });
  }

  url(i) {
    // ffmpeg's image2 muxer numbers output files from 1, not 0
    return this.path + this.prefix + String(i + 1).padStart(this.pad, "0") + this.ext;
  }

  load(onProgress, concurrency = 10) {
    let loaded = 0;
    let next = 0;
    return new Promise((resolve) => {
      const tick = () => {
        loaded++;
        if (onProgress) onProgress(loaded / this.count);
        if (loaded === this.count) resolve(this);
      };
      const pump = () => {
        while (next < this.count) {
          const i = next++;
          const img = new Image();
          img.decoding = "async";
          img.onload = () => { this.images[i] = img; if (i === this.current) this.draw(i); tick(); pump(); };
          img.onerror = tick;
          img.src = this.url(i);
          if (next - loaded >= concurrency) break;
        }
      };
      pump();
    });
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  nearestLoaded(i) {
    if (this.images[i]) return i;
    for (let d = 1; d < this.count; d++) {
      if (this.images[i - d]) return i - d;
      if (this.images[i + d]) return i + d;
    }
    return -1;
  }

  draw(i) {
    const idx = this.nearestLoaded(Math.max(0, Math.min(this.count - 1, Math.round(i))));
    if (idx < 0) return;
    this.current = idx;
    const img = this.images[idx];
    const cw = this.canvas.width, ch = this.canvas.height;
    const scale = Math.max(cw / img.width, ch / img.height) * this.overscan;
    const dw = img.width * scale, dh = img.height * scale;
    this.ctx.clearRect(0, 0, cw, ch);
    this.ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }
}

/* ------------------------------------------------------------
   Boot
   ------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((t) => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);
lenis.stop();

const heroSeq = new FrameSequence($("#heroCanvas"), {
  path: "assets/frames/hero/", count: 361,
});
const astroSeq = new FrameSequence($("#astroCanvas"), {
  path: "assets/frames/astro/", count: 361, overscan: 1.1,
});

const loaderFill = $("#loaderFill");
const loaderPct = $("#loaderPct");

Promise.all([
  heroSeq.load((p) => {
    loaderFill.style.width = (p * 100).toFixed(1) + "%";
    loaderPct.textContent = Math.round(p * 100) + "%";
  }),
  document.fonts ? document.fonts.ready : Promise.resolve(),
]).then(() => {
  astroSeq.load(null, 6); // second act streams in behind the scenes
  armEnterGate(init());
});

/* ------------------------------------------------------------
   Sound — two ambient loops, one per act, crossfaded by scroll.
   Web Audio for gapless looping; created on the enter click so
   the context is born inside a user gesture.
   ------------------------------------------------------------ */
const sound = {
  ctx: null, master: null, gains: null, on: false,

  async enable() {
    this.on = true;
    $("#soundToggle").classList.add("is-on");
    if (!this.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0;
        this.master.connect(this.ctx.destination);
        const decode = async (url) =>
          this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        const [saturn, spaceguy] = await Promise.all([
          decode("assets/sounds/saturn.mp3"),
          decode("assets/sounds/spaceguy.mp3"),
        ]);
        this.gains = {};
        for (const [name, buffer] of [["saturn", saturn], ["spaceguy", spaceguy]]) {
          const src = this.ctx.createBufferSource();
          src.buffer = buffer;
          src.loop = true;
          const gain = this.ctx.createGain();
          gain.gain.value = name === "saturn" ? 1 : 0;
          src.connect(gain).connect(this.master);
          src.start(0);
          this.gains[name] = gain.gain;
        }
      } catch (err) {
        console.warn("SPACE Z: audio unavailable —", err);
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    gsap.to(this.master.gain, { value: 0.55, duration: 1.8, ease: "power1.inOut" });
  },

  disable() {
    this.on = false;
    $("#soundToggle").classList.remove("is-on");
    if (!this.ctx) return;
    gsap.to(this.master.gain, {
      value: 0, duration: 0.7, ease: "power1.out",
      onComplete: () => this.ctx.suspend(),
    });
  },

  toggle() { this.on ? this.disable() : this.enable(); },

  /* crossfade the two loops when the story changes acts */
  scene(name) {
    if (!this.gains) return;
    const other = name === "saturn" ? "spaceguy" : "saturn";
    gsap.to(this.gains[name], { value: 1, duration: 1.6, ease: "power1.inOut" });
    gsap.to(this.gains[other], { value: 0, duration: 1.6, ease: "power1.inOut" });
  },
};

/* ------------------------------------------------------------
   Enter gate — the click that starts the film (and the audio)
   ------------------------------------------------------------ */
function armEnterGate(titleChars) {
  $("#loader").classList.add("is-ready");
  let entered = false;
  const begin = (withSound) => {
    if (entered) return;
    entered = true;
    if (withSound) sound.enable();
    introReveal(titleChars);
  };
  $("#enterSound").addEventListener("click", () => begin(true));
  $("#enterSilent").addEventListener("click", () => begin(false));
  $("#soundToggle").addEventListener("click", () => sound.toggle());
}

/* ------------------------------------------------------------
   Main init — everything scroll-driven lives here
   ------------------------------------------------------------ */
function init() {
  const heroChars = $$("[data-hero-title] .ht-main").map(splitChars);
  const missionChars = $$("[data-mission-title] .ht-main").map(splitChars);

  buildCursor();
  buildMagnetics();
  buildNav();
  buildHeroAct(heroChars);
  buildMissionAct(missionChars);
  buildReveals();
  buildResearch();
  buildMarquee();
  buildTech();
  buildGallery();
  buildStats();
  buildTimeline();
  buildFooter();

  ScrollTrigger.refresh();
  return heroChars[0];
}

/* ------------------------------------------------------------
   Loader exit + opening title
   ------------------------------------------------------------ */
function introReveal(titleChars) {
  const tl = gsap.timeline({
    onComplete() {
      // re-assert end states so nothing can revert them later
      gsap.set(".nav, .hero-hud", { clearProps: "transform,opacity,visibility" });
      gsap.set("[data-hero-title='0']", { autoAlpha: 1 });
      lenis.start();
      $("#loader").remove();
    },
  });
  tl.to("#loader", { autoAlpha: 0, duration: 0.9, ease: "power2.inOut", delay: 0.25 })
    .set("[data-hero-title='0']", { autoAlpha: 1 })
    .from("#heroCanvas", { scale: 1.12, duration: 2.2, ease: "power3.out" }, "<")
    .fromTo(titleChars,
      { opacity: 0, y: 90, rotateX: -55, filter: "blur(14px)" },
      { opacity: 1, y: 0, rotateX: 0, filter: "blur(0px)", duration: 1.3,
        stagger: 0.06, ease: "power4.out" }, "-=1.6")
    .from("[data-hero-title='0'] .ht-kicker",
      { opacity: 0, letterSpacing: "1.2em", duration: 1.1, ease: "power3.out" }, "-=1.0")
    .from("[data-hero-title='0'] .ht-sub", { opacity: 0, y: 20, duration: 0.8 }, "-=0.6")
    .from(".nav", { yPercent: -120, opacity: 0, duration: 0.9, ease: "power3.out" }, "-=0.8")
    .from(".hero-hud", { opacity: 0, y: 20, duration: 0.8 }, "-=0.6");
}

/* ------------------------------------------------------------
   ACT I — hero image sequence (pinned, scrubbed)
   ------------------------------------------------------------ */
function buildHeroAct(heroChars) {
  const frames = { value: 0 };
  const hudFrame = $("#hudFrame");
  const F = 360; // timeline is measured in frames

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: "#act-hero",
      start: "top top",
      end: REDUCED ? "+=100" : "+=4400",
      pin: true,
      scrub: REDUCED ? true : 0.7,
      anticipatePin: 1,
    },
  });

  /* title containers are shown/hidden declaratively from the film position —
     tween-based visibility proved fragile under giant single-step scrubs */
  const windows = [];
  const applyWindows = (pos) => {
    for (const w of windows) {
      const on = pos >= w.show && pos < w.hide;
      if (w.on !== on) { w.on = on; gsap.set(w.el, { autoAlpha: on ? 1 : 0 }); }
    }
  };

  // the film itself
  tl.to(frames, {
    value: F,
    duration: F,
    onUpdate() {
      heroSeq.draw(frames.value);
      applyWindows(frames.value);
      hudFrame.textContent = String(Math.round(frames.value)).padStart(4, "0");
    },
  }, 0);

  // layered parallax — everything moves at its own speed
  tl.to("[data-hero-layer='starsFar']", { yPercent: -4, duration: F }, 0)
    .to("[data-hero-layer='stars']", { yPercent: -10, duration: F }, 0)
    .to("[data-hero-layer='nebula']", { yPercent: -18, scale: 1.08, duration: F }, 0)
    .to("[data-hero-layer='glow']", { opacity: 0.35, duration: F * 0.4 }, 0)
    .to("[data-hero-layer='glow']", { opacity: 1, duration: F * 0.25 }, F * 0.62);

  // scroll hint + HUD retire early
  tl.to("#scrollHint", { autoAlpha: 0, y: 20, duration: 18 }, 4);

  const titleSets = $$("[data-hero-title]");
  const kickers = titleSets.map((t) => t.querySelector(".ht-kicker"));
  const subs = titleSets.map((t) => t.querySelector(".ht-sub"));

  /* every tween is a fromTo with immediateRender:false — fully explicit
     start AND end states, so scrubbing backwards (or any refresh) always
     reproduces the exact same picture */
  const IR = { immediateRender: false };
  const CHARS_IN = { opacity: 0, y: 80, scale: 0.92, rotateX: -40, filter: "blur(12px)" };
  const CHARS_ON = { opacity: 1, y: 0, scale: 1, rotateX: 0, filter: "blur(0px)" };
  const CHARS_OUT = { opacity: 0, y: -60, scale: 1.08, rotateX: 0, filter: "blur(14px)" };

  const titleIn = (el, chars, kicker, fIn, inD = 26) => {
    windows.push({ el, show: fIn - 1, hide: Infinity, on: null });
    tl.fromTo(chars, CHARS_IN,
      { ...CHARS_ON, duration: inD, stagger: 1.1, ease: "power2.out", ...IR }, fIn)
      .fromTo(kicker, { opacity: 0, y: 26 },
        { opacity: 1, y: 0, duration: inD, ease: "power2.out", ...IR }, fIn + 4);
  };
  const titleOut = (el, chars, kicker, fOut, outD = 30) => {
    windows.find((w) => w.el === el).hide = fOut + outD + chars.length * 0.7;
    tl.fromTo(chars, CHARS_ON,
      { ...CHARS_OUT, duration: outD, stagger: 0.7, ease: "power2.in", ...IR }, fOut)
      .fromTo(kicker, { opacity: 1, y: 0 },
        { opacity: 0, y: -20, duration: outD * 0.8, ...IR }, fOut);
  };

  // opening title is placed by introReveal; only scrub it OUT here
  windows.push({ el: titleSets[0], show: -Infinity, hide: 60, on: null });
  tl.fromTo(heroChars[0], CHARS_ON, {
    ...CHARS_OUT, y: -70, scale: 1.1,
    duration: 34, stagger: 1, ease: "power2.in", ...IR,
  }, 18)
    .fromTo([kickers[0], subs[0]], { opacity: 1, y: 0 },
      { opacity: 0, y: -24, duration: 26, ...IR }, 18);

  const show = (i, fIn, fOut) => {
    titleIn(titleSets[i], heroChars[i], kickers[i], fIn);
    if (fOut != null) titleOut(titleSets[i], heroChars[i], kickers[i], fOut);
  };
  show(1, 86, 148);   // ENGINEERING TOMORROW
  show(2, 176, 236);  // BEYOND EARTH
  show(3, 258, 310);  // THE FUTURE BEGINS HERE
  show(4, 336, null); // THE CROSSING — rides out with the planet reveal

  // cinematic exit: dim the film as the story continues below
  tl.to("#heroCanvas", { scale: 0.94, filter: "brightness(0.4)", duration: 30, ease: "power1.in" }, F - 26)
    .to(".act-hero .layer-vignette", { opacity: 0.2, duration: 30 }, F - 26);
}

/* ------------------------------------------------------------
   ACT II — mission sequence (astronaut)
   ------------------------------------------------------------ */
function buildMissionAct(missionChars) {
  const frames = { value: 0 };
  const F = 360;

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: "#act-mission",
      start: "top top",
      end: REDUCED ? "+=100" : "+=3800",
      pin: true,
      scrub: REDUCED ? true : 0.7,
      anticipatePin: 1,
      onToggle: (self) => sound.scene(self.isActive ? "spaceguy" : "saturn"),
    },
  });

  const windows = [];
  const applyWindows = (pos) => {
    for (const w of windows) {
      const on = pos >= w.show && pos < w.hide;
      if (w.on !== on) { w.on = on; gsap.set(w.el, { autoAlpha: on ? 1 : 0 }); }
    }
  };

  tl.to(frames, {
    value: F,
    duration: F,
    onUpdate() {
      astroSeq.draw(frames.value);
      applyWindows(frames.value);
    },
  }, 0);

  // entry: the act fades up from black like a scene cut
  tl.fromTo("#astroCanvas", { filter: "brightness(0)" },
    { filter: "brightness(1)", duration: 30, ease: "power2.out" }, 0);

  // heat shimmer builds as the lava pass approaches
  tl.to("[data-mission-layer='heat']", { opacity: 0.9, duration: 110 }, 190);

  const titleSets = $$("[data-mission-title]");
  const kickers = titleSets.map((t) => t.querySelector(".ht-kicker"));

  const IR = { immediateRender: false };
  const showTitle = (i, fIn, fOut) => {
    const chars = missionChars[i];
    const win = { el: titleSets[i], show: fIn - 1, hide: Infinity, on: null };
    windows.push(win);
    tl.fromTo(chars,
      { opacity: 0, y: 80, scale: 0.92, rotateX: -40, filter: "blur(12px)" },
      { opacity: 1, y: 0, scale: 1, rotateX: 0, filter: "blur(0px)",
        duration: 26, stagger: 1.1, ease: "power2.out", ...IR }, fIn)
      .fromTo(kickers[i], { opacity: 0, y: 26 },
        { opacity: 1, y: 0, duration: 26, ease: "power2.out", ...IR }, fIn + 4);
    if (fOut != null) {
      win.hide = fOut + 28 + chars.length * 0.7;
      tl.fromTo(chars,
        { opacity: 1, y: 0, scale: 1, rotateX: 0, filter: "blur(0px)" },
        { opacity: 0, y: -60, scale: 1.08, filter: "blur(14px)",
          duration: 28, stagger: 0.7, ease: "power2.in", ...IR }, fOut)
        .fromTo(kickers[i], { opacity: 1, y: 0 },
          { opacity: 0, y: -20, duration: 22, ...IR }, fOut);
    }
  };

  showTitle(0, 14, 84);
  showTitle(1, 122, 186);
  showTitle(2, 224, 288);
  showTitle(3, 320, null);

  tl.to("#astroCanvas", { filter: "brightness(0.35)", scale: 0.94, duration: 26, ease: "power1.in" }, F - 22);
}

/* ------------------------------------------------------------
   Generic reveals
   ------------------------------------------------------------ */
function buildReveals() {
  $$("[data-reveal='fade']").forEach((el) => {
    gsap.from(el, {
      opacity: 0, y: 44, duration: 1.1, ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 86%", toggleActions: "play none none reverse" },
    });
  });

  $$("[data-split='lines']").forEach((el) => {
    const lines = splitLines(el);
    gsap.from(lines, {
      yPercent: 115, duration: 1.2, stagger: 0.1, ease: "expo.out",
      scrollTrigger: { trigger: el, start: "top 84%", toggleActions: "play none none reverse" },
    });
  });
}

/* ------------------------------------------------------------
   Scene 2 — research panels (mask reveal + zoom)
   ------------------------------------------------------------ */
function buildResearch() {
  $$("[data-panel]").forEach((panel) => {
    const imgWrap = $(".panel-img", panel);
    const img = $("img", panel);
    gsap.to(imgWrap, {
      clipPath: "inset(0% 0% 0% 0% round 6px)", ease: "none",
      scrollTrigger: { trigger: panel, start: "top 90%", end: "top 38%", scrub: 0.8 },
    });
    gsap.fromTo(img, { scale: 1.25 }, {
      scale: 1, ease: "none",
      scrollTrigger: { trigger: panel, start: "top 95%", end: "bottom 20%", scrub: 0.8 },
    });
    gsap.from($("figcaption", panel), {
      opacity: 0, y: 26, duration: 0.9, ease: "power3.out",
      scrollTrigger: { trigger: panel, start: "top 55%", toggleActions: "play none none reverse" },
    });
  });
}

/* ------------------------------------------------------------
   Intro marquee — velocity-reactive drift
   ------------------------------------------------------------ */
function buildMarquee() {
  const track = $("#marqueeTrack");
  if (!track) return;
  const loop = gsap.to(track, { xPercent: -50, duration: 26, ease: "none", repeat: -1 });
  lenis.on("scroll", ({ velocity }) => {
    loop.timeScale(gsap.utils.clamp(0.6, 5, 1 + Math.abs(velocity) * 0.06));
  });
}

/* ------------------------------------------------------------
   Scene 3 — horizontal technology rail
   ------------------------------------------------------------ */
function buildTech() {
  const track = $("#techTrack");
  const dist = () => track.scrollWidth - window.innerWidth + window.innerWidth * 0.1;

  const rail = gsap.to(track, {
    x: () => -dist(),
    ease: "none",
    scrollTrigger: {
      trigger: "#tech",
      start: "top top",
      end: () => "+=" + dist(),
      pin: true,
      scrub: 0.7,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onUpdate(self) {
        $("#techProgressFill").style.transform = `scaleX(${self.progress})`;
      },
    },
  });

  gsap.to("#techGhost", {
    x: () => dist() * 0.22,
    ease: "none",
    scrollTrigger: { trigger: "#tech", start: "top top", end: () => "+=" + dist(), scrub: 0.7 },
  });

  $$("[data-tcard]").forEach((card) => {
    gsap.from(card, {
      y: 90, opacity: 0, rotate: 2.5, scale: 0.92,
      duration: 1, ease: "power3.out",
      scrollTrigger: {
        trigger: card,
        containerAnimation: rail,
        start: "left 92%",
        toggleActions: "play none none reverse",
      },
    });
  });
}

/* ------------------------------------------------------------
   Scene 5 — gallery (reveal, zoom, parallax, 3D hover)
   ------------------------------------------------------------ */
function buildGallery() {
  $$("[data-gitem]").forEach((item) => {
    const wrap = $(".gitem-img", item);
    const img = $("img", item);

    gsap.from(wrap, {
      clipPath: "inset(100% 0% 0% 0%)", duration: 1.3, ease: "expo.out",
      scrollTrigger: { trigger: item, start: "top 82%", toggleActions: "play none none reverse" },
    });
    gsap.fromTo(img, { scale: 1.3, yPercent: -8 }, {
      scale: 1.05, yPercent: 8, ease: "none",
      scrollTrigger: { trigger: item, start: "top bottom", end: "bottom top", scrub: 0.6 },
    });
    gsap.from($$("figcaption > *", item), {
      opacity: 0, y: 24, stagger: 0.12, duration: 0.8, ease: "power3.out",
      scrollTrigger: { trigger: item, start: "top 65%", toggleActions: "play none none reverse" },
    });

    if (!FINE_POINTER) return;
    const rx = gsap.quickTo(wrap, "rotationX", { duration: 0.5, ease: "power3.out" });
    const ry = gsap.quickTo(wrap, "rotationY", { duration: 0.5, ease: "power3.out" });
    gsap.set(wrap, { transformPerspective: 800 });
    item.addEventListener("mousemove", (e) => {
      const r = wrap.getBoundingClientRect();
      ry(gsap.utils.mapRange(0, r.width, -7, 7, e.clientX - r.left));
      rx(gsap.utils.mapRange(0, r.height, 5, -5, e.clientY - r.top));
    });
    item.addEventListener("mouseleave", () => { rx(0); ry(0); });
  });
}

/* ------------------------------------------------------------
   Statistics — counters fire when visible
   ------------------------------------------------------------ */
function buildStats() {
  const stats = $$("[data-stat]");
  gsap.from(stats, {
    opacity: 0, y: 50, scale: 0.94, stagger: 0.13, duration: 1, ease: "power3.out",
    scrollTrigger: { trigger: ".scene-stats", start: "top 78%" },
  });
  stats.forEach((stat) => {
    const b = $("b", stat);
    const target = parseFloat(b.dataset.count);
    const suffix = b.dataset.suffix || "";
    const obj = { v: 0 };
    ScrollTrigger.create({
      trigger: stat, start: "top 82%", once: true,
      onEnter() {
        stat.classList.add("is-lit");
        gsap.to(obj, {
          v: target, duration: 2.2, ease: "power3.out",
          onUpdate() {
            b.textContent = Math.round(obj.v).toLocaleString("en-US") + suffix;
          },
        });
      },
    });
  });
}

/* ------------------------------------------------------------
   Timeline — pinned mission log
   ------------------------------------------------------------ */
function buildTimeline() {
  const items = $$("[data-tl]");

  const tl = gsap.timeline({
    defaults: { ease: "power2.out" },
    scrollTrigger: {
      trigger: "#timeline",
      start: "top top",
      end: "+=" + (items.length * 420),
      pin: true,
      scrub: 0.6,
      anticipatePin: 1,
    },
  });

  tl.fromTo("#tlLineFill", { scaleY: 0 }, { scaleY: 1, duration: items.length, ease: "none" }, 0);

  items.forEach((item, i) => {
    const fromLeft = i % 2 === 0;
    const card = $(".tl-card", item);
    const dot = $(".tl-dot", item);
    const at = i * 0.92 + 0.12;
    tl.fromTo(card,
      { x: fromLeft ? -70 : 70, opacity: 0, rotate: fromLeft ? -2 : 2 },
      { x: 0, opacity: 1, rotate: 0, duration: 0.7 }, at)
      .fromTo(dot,
        { scale: 0.5, backgroundColor: "#04060a", borderColor: "rgba(238,242,247,0.28)", boxShadow: "0 0 0 rgba(240,163,92,0)" },
        { scale: 1.25, backgroundColor: "#f0a35c", borderColor: "#f0a35c", boxShadow: "0 0 18px rgba(240,163,92,0.9)", duration: 0.4 }, at + 0.15);
  });
}

/* ------------------------------------------------------------
   Footer reveal — page curtain lifts off a fixed footer
   ------------------------------------------------------------ */
function buildFooter() {
  $("#page").style.marginBottom = "100vh";
  const footer = $("#footer");

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: "#page",
      start: "bottom bottom",
      end: "bottom top",
      scrub: 0.5,
      /* progress-based, not isActive: at full scroll the trigger sits exactly
         on its end boundary and isActive would flip false, hiding the footer */
      onUpdate: (self) => footer.classList.toggle("is-live", self.progress > 0.001),
      onRefresh: (self) => footer.classList.toggle("is-live", self.progress > 0.001),
    },
  });

  tl.fromTo("#footerLogo", { scale: 0.62, yPercent: 30, opacity: 0.4 },
    { scale: 1, yPercent: 0, opacity: 1 }, 0)
    .fromTo(".footer-socials a", { y: 40, opacity: 0 },
      { y: 0, opacity: 1, stagger: 0.06, ease: "power2.out" }, 0.25)
    .fromTo([".footer-line", ".to-top", ".footer-fine"], { opacity: 0, y: 20 },
      { opacity: 1, y: 0, stagger: 0.08, ease: "power2.out" }, 0.4);

  $("#toTop").addEventListener("click", () => {
    lenis.scrollTo(0, { duration: 2.6, easing: (t) => 1 - Math.pow(1 - t, 4) });
  });
}

/* ------------------------------------------------------------
   Nav — hide on dive, show on surface; progress bar; anchors
   ------------------------------------------------------------ */
function buildNav() {
  const nav = $("#nav");
  const fill = $("#scrollProgressFill");
  let lastY = 0;
  lenis.on("scroll", ({ scroll, limit }) => {
    fill.style.transform = `scaleX(${limit ? scroll / limit : 0})`;
    if (scroll > 300 && scroll > lastY + 4) nav.classList.add("is-hidden");
    else if (scroll < lastY - 4 || scroll <= 300) nav.classList.remove("is-hidden");
    lastY = scroll;
  });

  $$("[data-scrollto]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const target = a.getAttribute("href");
      if (!target || !target.startsWith("#")) return;
      e.preventDefault();
      lenis.scrollTo(target, { duration: 2, easing: (t) => 1 - Math.pow(1 - t, 4), offset: 0 });
    });
  });
}

/* ------------------------------------------------------------
   Cursor + magnetic elements
   ------------------------------------------------------------ */
function buildCursor() {
  if (!FINE_POINTER || REDUCED) return;
  document.body.classList.add("has-cursor");
  const dot = $("#cursorDot"), ring = $("#cursorRing"),
        glow = $("#cursorGlow"), label = $("#cursorLabel");

  const pos = { x: innerWidth / 2, y: innerHeight / 2 };
  const ringPos = { ...pos }, glowPos = { ...pos };
  const setDot = gsap.quickSetter(dot, "css");
  const setRing = gsap.quickSetter(ring, "css");
  const setGlow = gsap.quickSetter(glow, "css");

  window.addEventListener("mousemove", (e) => { pos.x = e.clientX; pos.y = e.clientY; });
  gsap.ticker.add(() => {
    ringPos.x += (pos.x - ringPos.x) * 0.16;
    ringPos.y += (pos.y - ringPos.y) * 0.16;
    glowPos.x += (pos.x - glowPos.x) * 0.07;
    glowPos.y += (pos.y - glowPos.y) * 0.07;
    setDot({ x: pos.x, y: pos.y });
    setRing({ x: ringPos.x, y: ringPos.y });
    setGlow({ x: glowPos.x, y: glowPos.y });
  });

  document.addEventListener("mouseover", (e) => {
    const hot = e.target.closest("a, button, [data-magnetic]");
    const labelled = e.target.closest("[data-cursor]");
    ring.classList.toggle("is-hover", !!hot && !labelled);
    ring.classList.toggle("has-label", !!labelled);
    label.textContent = labelled ? labelled.dataset.cursor : "";
  });
}

function buildMagnetics() {
  if (!FINE_POINTER || REDUCED) return;
  $$("[data-magnetic]").forEach((el) => {
    const xTo = gsap.quickTo(el, "x", { duration: 0.9, ease: "elastic.out(1, 0.4)" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.9, ease: "elastic.out(1, 0.4)" });
    el.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.35);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.35);
    });
    el.addEventListener("mouseleave", () => { xTo(0); yTo(0); });
  });
}

/* debug handle, same convention as the other portfolio sites */
window.__spacez = { lenis, heroSeq, astroSeq };
