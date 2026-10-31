// On a computer, every scrollbar is a vine: the page's, and each scrolling box's (dialogs, the printings
// list). A vine hangs down the scroller's right edge and grows as far as it's been read (it stays grown
// when scrolling back up). Its leaves are the scroller's sections (its headings), each where that section
// sits in it: pick one to jump there; ones not reached yet are still buds. A pixel elf climbs it to wherever
// it's scrolled, hand over hand while it moves (faster when it moves faster), resting when it stops; drag
// the elf, or pick anywhere on the vine, to scroll. The wheel and keys scroll as ever. The elf holds still
// for anyone who would rather have less motion. On a phone, scrollbars stay as they are.

// The elf from behind, gripping the vine. H hood and tunic, h tunic (lighter), S skin, E ears, b belt, B boots
const FRAMES = {
  left: [ // left hand up, right foot up
    "..S.......",
    "..S.HHH...",
    "..SHHHHHH.",
    ".EHHHHHHHE",
    "..hHHHHHh.",
    "..hhhhhhhS",
    "...hhhhh.S",
    "...hhhhh..",
    "...bbbbb..",
    "...hh.hh..",
    "...hh.hh..",
    "...hh.BB..",
    "..BB......",
  ],
  rest: [ // both hands on the vine
    "..........",
    "....HHH...",
    "...HHHHHH.",
    ".EHHHHHHHE",
    "..hHHHHHh.",
    ".Shhhhhhh.",
    ".S.hhhhhS.",
    "...hhhhhS.",
    "...bbbbb..",
    "...hh.hh..",
    "...hh.hh..",
    "...hh.hh..",
    "..BB..BB..",
  ],
};
FRAMES.right = FRAMES.left.map(row => [...row].reverse().join("")); // the other hand and foot
const COLORS = { H: "#2f6b3a", h: "#4c9a52", S: "#e9bb8c", E: "#e9bb8c", b: "#8a5a2b", B: "#5b3a20" };
// The scrolling boxes that get a vine (the page always does); a dialog's starts under its close button
const SCROLLERS = "dialog, .printings";
const SECTIONS = "h2, h3";
const STEP = 22; // pixels scrolled to a hand-over-hand step

const desktop = matchMedia("(min-width: 1100px) and (pointer: fine)");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const page = document.scrollingElement;

class Vine {
  // scroller: the page (document.scrollingElement) or a scrolling box
  constructor(scroller) {
    this.scroller = scroller;
    this.isPage = scroller === page;
    this.scale = this.isPage ? 3 : 2;
    this.width = this.isPage ? 40 : 26;
    this.inset = scroller.tagName === "DIALOG" ? 56 : 0;
    this.grown = 0;
    this.travelled = 0;
    this.lastTop = this.top;
    this.box = document.createElement("div");
    this.box.className = "vine";
    this.box.setAttribute("aria-hidden", "true");
    this.art = svg("svg", { width: this.width });
    this.stem = svg("path", { class: "stem", pathLength: 1 });
    this.ghost = svg("path", { class: "ghost" }); // the whole vine, faint: where it can still grow
    this.track = svg("rect", { class: "track", x: 0, y: 0, width: this.width });
    this.leaves = svg("g");
    this.elf = svg("g", { class: "elf" });
    this.frames = {};
    for (const [name, rows] of Object.entries(FRAMES)) {
      const g = svg("g", { visibility: "hidden" });
      rows.forEach((row, y) => [...row].forEach((c, x) => {
        if (COLORS[c]) g.append(svg("rect", { x: x * this.scale, y: y * this.scale, width: this.scale, height: this.scale, fill: COLORS[c] }));
      }));
      this.frames[name] = g;
      this.elf.append(g);
    }
    this.shown = "left";
    this.show("rest");
    this.elfW = FRAMES.rest[0].length * this.scale;
    this.elfH = FRAMES.rest.length * this.scale;
    this.elf.append(svg("rect", { class: "grip", x: -4, y: -4, width: this.elfW + 8, height: this.elfH + 8 }));
    this.art.append(this.track, this.ghost, this.stem, this.leaves, this.elf);
    this.box.append(this.art);
    // Inside a dialog, so it's drawn over the backdrop with it
    (this.isPage ? document.body : scroller.tagName === "DIALOG" ? scroller : scroller.closest("dialog") ?? document.body).append(this.box);
    this.drag();
    this.height = -1;
    this.sectionsAt = "";
  }
  get top() { return this.scroller.scrollTop; }
  get room() { return this.scroller.scrollHeight - this.scroller.clientHeight; }
  show(name) {
    if (name === this.shown) return;
    this.frames[this.shown].setAttribute("visibility", "hidden");
    this.frames[(this.shown = name)].setAttribute("visibility", "visible");
  }
  x(y) { return this.width / 2 + (this.isPage ? 5 : 3) * Math.sin(y / 42); } // gently wavy
  // Where its scroller is on screen: [left, top, height] of the vine
  where() {
    if (this.isPage) return [document.documentElement.clientWidth - this.width, 0, innerHeight];
    const r = this.scroller.getBoundingClientRect();
    return [r.right - this.width - 2, r.top + this.inset, Math.max(0, r.height - this.inset - 4)];
  }
  // Redrawn on the next frame (moved: it was scrolled, so the elf climbs)
  queue(moved = false) {
    this.moved ||= moved;
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.update();
    });
  }
  update() {
    const on = this.scroller.isConnected && (this.isPage || this.scroller.offsetParent !== null || this.scroller.open)
      && this.room > (this.isPage ? 200 : 8);
    this.box.hidden = !on;
    if (!on) return;
    const [left, top, height] = this.where();
    Object.assign(this.box.style, { left: `${left}px`, top: `${top}px`, height: `${height}px`, width: `${this.width}px` });
    // In a dialog, "fixed" can be to the dialog rather than the window: put right by where it actually landed
    const at = this.box.getBoundingClientRect();
    if (Math.abs(at.left - left) > 0.5 || Math.abs(at.top - top) > 0.5) {
      Object.assign(this.box.style, { left: `${2 * left - at.left}px`, top: `${2 * top - at.top}px` });
    }
    if (height !== this.height) this.draw(height);
    const read = Math.min(1, Math.max(0, this.top / this.room));
    this.grown = Math.max(this.grown, read);
    this.stem.style.strokeDashoffset = 1 - this.grown;
    const y = read * (height - this.elfH);
    this.elf.setAttribute("transform", `translate(${(this.x(y + this.elfH / 2) - this.elfW / 2).toFixed(1)} ${y.toFixed(1)})`);
    this.sections();
    for (const leaf of this.leaves.children) leaf.classList.toggle("out", +leaf.dataset.y <= this.grown * height + 2);
    if (this.moved) this.climb();
  }
  // The stem, for its height
  draw(height) {
    this.height = height;
    this.art.setAttribute("height", height);
    this.track.setAttribute("height", height);
    let d = `M${this.x(0).toFixed(1)} 0`;
    for (let y = 4; y <= height; y += 4) d += `L${this.x(y).toFixed(1)} ${y}`;
    this.stem.setAttribute("d", d);
    this.ghost.setAttribute("d", d);
    this.sectionsAt = "";
  }
  // A leaf for each section (heading) showing in the scroller, where it sits along it; picking one goes there
  sections() {
    const room = this.scroller.scrollHeight, base = this.isPage ? 0 : this.scroller.getBoundingClientRect().top;
    const found = [...this.scroller.querySelectorAll(SECTIONS)].filter(h => h.offsetParent !== null && h.textContent.trim())
      .map(h => ({ h, at: h.getBoundingClientRect().top - base + this.top }));
    const key = `${room}|${found.map(f => Math.round(f.at)).join(",")}`;
    if (key === this.sectionsAt) return;
    this.sectionsAt = key;
    this.leaves.replaceChildren();
    let last = -Infinity, side = 1;
    for (const { h, at } of found) {
      const y = Math.min(this.height - 6, Math.max(6, (at / room) * this.height));
      if (y - last < 16) continue; // too close to the one before to pick apart
      last = y;
      const leaf = svg("g", { class: "leaf", transform: `translate(${this.x(y).toFixed(1)} ${y.toFixed(1)}) scale(${side} 1)` });
      const size = this.isPage ? 1 : 0.75;
      leaf.append(svg("title"), svg("circle", { class: "hit", r: 10 }),
        svg("path", { d: `M0 0q${7 * size} ${-7 * size} ${15 * size} ${-3 * size}q${-7 * size} ${7 * size} ${-15 * size} ${3 * size}z` }));
      leaf.firstChild.textContent = h.textContent.trim().replace(/\s+/g, " ");
      leaf.dataset.y = y;
      leaf.addEventListener("click", e => {
        e.stopPropagation();
        this.scroller.scrollTo({ top: Math.max(0, at - 12), behavior: still.matches ? "auto" : "smooth" });
      });
      this.leaves.append(leaf);
      side = -side;
    }
  }
  // Hand over hand: a step every STEP pixels scrolled, resting once the scrolling stops
  climb() {
    this.moved = false;
    this.travelled += Math.abs(this.top - this.lastTop);
    this.lastTop = this.top;
    if (!still.matches) this.show(Math.floor(this.travelled / STEP) % 2 ? "left" : "right");
    clearTimeout(this.resting);
    this.resting = setTimeout(() => this.show("rest"), 450);
  }
  // Dragging the elf scrolls; picking the vine anywhere else jumps there
  drag() {
    const to = clientY => {
      const [, top, height] = this.where();
      const share = (clientY - top - this.elfH / 2) / Math.max(1, height - this.elfH);
      this.scroller.scrollTop = Math.min(1, Math.max(0, share)) * this.room;
    };
    this.box.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest(".leaf")) return;
      e.preventDefault();
      this.box.setPointerCapture(e.pointerId);
      this.box.classList.add("held");
      to(e.clientY);
      const move = m => to(m.clientY);
      const up = () => {
        this.box.classList.remove("held");
        this.box.removeEventListener("pointermove", move);
        this.box.removeEventListener("pointerup", up);
        this.box.removeEventListener("pointercancel", up);
      };
      this.box.addEventListener("pointermove", move);
      this.box.addEventListener("pointerup", up);
      this.box.addEventListener("pointercancel", up);
    });
  }
}

// One vine a scroller, found again as the page changes (a dialog opening, a list filling in)
const vines = new Map();
function refresh() {
  document.documentElement.classList.toggle("vines", desktop.matches);
  if (!desktop.matches) {
    for (const v of vines.values()) v.box.hidden = true;
    return;
  }
  for (const el of [page, ...document.querySelectorAll(SCROLLERS)]) {
    if (!vines.has(el)) vines.set(el, new Vine(el));
    vines.get(el).queue();
  }
  for (const [el, v] of vines) if (!el.isConnected) { v.box.remove(); vines.delete(el); }
}
let pending = 0;
const later = () => {
  clearTimeout(pending);
  pending = setTimeout(refresh, 120);
};
// Any scrolling: its own vine climbs; the others are placed again (a box in a dialog moves when the dialog scrolls)
document.addEventListener("scroll", e => {
  for (const v of vines.values()) v.queue(v.scroller === e.target || (v.isPage && e.target === document));
}, { capture: true, passive: true });
new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
new ResizeObserver(later).observe(document.body);
addEventListener("resize", later);
desktop.addEventListener("change", refresh);
// A dialog's own animation moves it as it opens: placed again once it's done
document.addEventListener("animationend", later, true);
refresh();
