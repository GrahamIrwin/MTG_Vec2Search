// On a computer, every scrollbar is a spindown: the page's, and each scrolling box's (dialogs, the
// printings list). A d20 rides a rail down the scroller's right edge, counting up as it goes: 1 at the top,
// 20 at the bottom. It tumbles while the scroller moves and lands face up when it
// stops. The rail fills in as far as it's been read. +1/+1 counters on it are the scroller's sections (its
// headings), each where the die lands with that section at the top: pick one to go there; ones not reached
// yet are hollow. Drag the die, or pick anywhere on the rail, to scroll; the wheel and keys scroll as ever.
// The die doesn't tumble for anyone who would rather have less motion. On a phone, scrollbars stay as they are.

// The scrolling boxes that get one (the page always does); a dialog's starts under its close button
const SCROLLERS = "dialog, .printings";
const SECTIONS = "h2, h3";
const ROLL = 1.6; // degrees the die turns a pixel scrolled
const JUMP_GAP = 12; // pixels above a section left showing when jumping to it

const desktop = matchMedia("(min-width: 1100px) and (pointer: fine)");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const page = document.scrollingElement;

// A d20 seen point-on: a hexagon, the triangle facing up in its middle, and the lines between them
function d20(r) {
  const at = (deg, k = 1) => [r * k * Math.cos((deg * Math.PI) / 180), r * k * Math.sin((deg * Math.PI) / 180)];
  const hex = [-90, -30, 30, 90, 150, 210].map(d => at(d));
  const tri = [-90, 30, 150].map(d => at(d, 0.56));
  const p = pts => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const g = svg("g", { class: "die" });
  g.append(svg("polygon", { class: "body", points: p(hex) }), svg("polygon", { class: "face", points: p(tri) }));
  // each corner of the middle triangle to the three hexagon corners nearest it
  [[0, [5, 0, 1]], [1, [1, 2, 3]], [2, [3, 4, 5]]].forEach(([t, hs]) => hs.forEach(h =>
    g.append(svg("line", { class: "edge", x1: tri[t][0], y1: tri[t][1], x2: hex[h][0], y2: hex[h][1] }))));
  const number = svg("text", { class: "number", "text-anchor": "middle", y: (r * 0.18).toFixed(1), "font-size": (r * 0.5).toFixed(1) });
  g.append(number);
  return { g, number };
}

class Spindown {
  // scroller: the page (document.scrollingElement) or a scrolling box
  constructor(scroller) {
    this.scroller = scroller;
    this.isPage = scroller === page;
    this.r = this.isPage ? 17 : 12; // the die's radius
    this.width = 2 * this.r + 8;
    this.inset = scroller.tagName === "DIALOG" ? 56 : 0;
    this.grown = 0;
    this.travelled = 0;
    this.lastTop = this.top;
    this.box = document.createElement("div");
    this.box.className = "spindown";
    this.box.setAttribute("aria-hidden", "true");
    this.art = svg("svg", { width: this.width });
    this.track = svg("rect", { class: "track", x: 0, y: 0, width: this.width });
    this.rail = svg("line", { class: "rail", x1: this.width / 2, x2: this.width / 2, y1: 0 });
    this.read = svg("line", { class: "read", x1: this.width / 2, x2: this.width / 2, y1: 0, y2: 0 });
    this.counters = svg("g");
    this.holder = svg("g", { class: "holder" }); // where the die is; the die turns inside it
    const { g, number } = d20(this.r);
    this.die = g;
    this.number = number;
    this.holder.append(this.die, svg("circle", { class: "grip", r: this.r + 4 }));
    this.art.append(this.track, this.rail, this.read, this.counters, this.holder);
    this.box.append(this.art);
    // Inside a dialog, so it's drawn over the backdrop with it
    (this.isPage ? document.body : scroller.tagName === "DIALOG" ? scroller : scroller.closest("dialog") ?? document.body).append(this.box);
    this.drag();
    this.height = -1;
    this.sectionsAt = "";
    this.angle = 0;
  }
  get top() { return this.scroller.scrollTop; }
  get room() { return this.scroller.scrollHeight - this.scroller.clientHeight; }
  // Where the die's middle is with the scroller scrolled to `top`: the rail is the die's whole range
  y(top) { return this.r + Math.min(1, Math.max(0, top / Math.max(1, this.room))) * (this.height - 2 * this.r); }
  // Where its scroller is on screen: [left, top, height] of the rail
  where() {
    if (this.isPage) return [document.documentElement.clientWidth - this.width, 0, innerHeight];
    const r = this.scroller.getBoundingClientRect();
    return [r.right - this.width - 2, r.top + this.inset, Math.max(0, r.height - this.inset - 4)];
  }
  // Redrawn on the next frame (moved: it was scrolled, so the die rolls)
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
    const share = Math.min(1, Math.max(0, this.top / this.room));
    this.grown = Math.max(this.grown, share);
    const y = this.y(this.top);
    this.read.setAttribute("y2", (this.r + this.grown * (height - 2 * this.r)).toFixed(1));
    this.holder.setAttribute("transform", `translate(${this.width / 2} ${y.toFixed(1)})`);
    this.number.textContent = 1 + Math.round(share * 19); // 1 at the top, 20 at the bottom
    this.sections();
    for (const c of this.counters.children) c.classList.toggle("reached", +c.dataset.y <= this.y(this.grown * this.room) + 1);
    if (this.moved) this.roll();
  }
  draw(height) {
    this.height = height;
    this.art.setAttribute("height", height);
    this.track.setAttribute("height", height);
    this.rail.setAttribute("y1", this.r);
    this.rail.setAttribute("y2", height - this.r);
    this.read.setAttribute("y1", this.r);
    this.sectionsAt = "";
  }
  // A +1/+1 counter for each section (heading) showing in the scroller, where the die lands with that
  // section at the top (so picking it, the die lands on it); picking one goes there
  sections() {
    const base = this.isPage ? 0 : this.scroller.getBoundingClientRect().top;
    const found = [...this.scroller.querySelectorAll(SECTIONS)].filter(h => h.offsetParent !== null && h.textContent.trim())
      .map(h => ({ h, to: Math.max(0, Math.round(h.getBoundingClientRect().top - base + this.top - JUMP_GAP)) }));
    const key = `${this.room}|${this.height}|${found.map(f => f.to).join(",")}`;
    if (key === this.sectionsAt) return;
    this.sectionsAt = key;
    this.counters.replaceChildren();
    let last = -Infinity;
    const size = this.isPage ? 7 : 5.5;
    for (const { h, to } of found) {
      const y = this.y(to);
      if (y - last < 2 * size + 4) continue; // too close to the one before to pick apart
      last = y;
      const c = svg("g", { class: "counter", transform: `translate(${this.width / 2} ${y.toFixed(1)})` });
      c.append(svg("title"), svg("circle", { class: "hit", r: size + 5 }), svg("circle", { class: "token", r: size }),
        svg("path", { class: "plus", d: `M${-size * 0.5} 0H${size * 0.5}M0 ${-size * 0.5}V${size * 0.5}` }));
      c.firstChild.textContent = h.textContent.trim().replace(/\s+/g, " ");
      c.dataset.y = y;
      c.addEventListener("click", e => {
        e.stopPropagation();
        this.scroller.scrollTo({ top: to, behavior: still.matches ? "auto" : "smooth" });
      });
      this.counters.append(c);
    }
  }
  // Tumbling while it moves, by how far; face up again once it stops
  roll() {
    this.moved = false;
    const step = this.top - this.lastTop;
    this.lastTop = this.top;
    if (still.matches) return;
    this.angle += step * ROLL;
    this.die.classList.remove("settling");
    this.die.style.transform = `rotate(${this.angle.toFixed(1)}deg)`;
    clearTimeout(this.resting);
    this.resting = setTimeout(() => {
      this.angle = Math.round(this.angle / 360) * 360; // the nearest way up
      this.die.classList.add("settling");
      this.die.style.transform = `rotate(${this.angle}deg)`;
    }, 300);
  }
  // Dragging the die scrolls; picking the rail anywhere else jumps there
  drag() {
    const to = clientY => {
      const [, top] = this.where();
      const share = (clientY - top - this.r) / Math.max(1, this.height - 2 * this.r);
      this.scroller.scrollTop = Math.min(1, Math.max(0, share)) * this.room;
    };
    this.box.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest(".counter")) return;
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

// One a scroller, found again as the page changes (a dialog opening, a list filling in)
const spindowns = new Map();
function refresh() {
  document.documentElement.classList.toggle("spindowns", desktop.matches);
  if (!desktop.matches) {
    for (const s of spindowns.values()) s.box.hidden = true;
    return;
  }
  for (const el of [page, ...document.querySelectorAll(SCROLLERS)]) {
    if (!spindowns.has(el)) spindowns.set(el, new Spindown(el));
    spindowns.get(el).queue();
  }
  for (const [el, s] of spindowns) if (!el.isConnected) { s.box.remove(); spindowns.delete(el); }
}
let pending = 0;
const later = () => {
  clearTimeout(pending);
  pending = setTimeout(refresh, 120);
};
// Any scrolling: its own die rolls; the others are placed again (a box in a dialog moves when the dialog scrolls)
document.addEventListener("scroll", e => {
  for (const s of spindowns.values()) s.queue(s.scroller === e.target || (s.isPage && e.target === document));
}, { capture: true, passive: true });
new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
new ResizeObserver(later).observe(document.body);
addEventListener("resize", later);
desktop.addEventListener("change", refresh);
// A dialog's own animation moves it as it opens: placed again once it's done
document.addEventListener("animationend", later, true);
refresh();
