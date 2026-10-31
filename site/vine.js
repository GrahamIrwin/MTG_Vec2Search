// A vine by the scrollbar, on a computer: it hangs from the top of the window and grows down as far as
// the page has been read (it stays grown when scrolling back up), sprouting leaves as it goes, and a
// little elf climbs it to wherever the page is scrolled: hand over hand while it moves, faster when it
// moves faster, resting when it stops. Decorative only (the scrollbar still scrolls); still for anyone who
// would rather have less motion.

const SCALE = 3; // screen pixels to a sprite pixel
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
const WIDTH = 40, LEAF_EVERY = 70;

const wide = matchMedia("(min-width: 1100px) and (pointer: fine)");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const box = document.createElement("div");
box.id = "vine";
box.setAttribute("aria-hidden", "true");
const art = svg("svg", { width: WIDTH });
const stem = svg("path", { class: "stem", pathLength: 1 });
const leaves = svg("g");
const elf = svg("g", { class: "elf" });
const frames = {};
for (const [name, rows] of Object.entries(FRAMES)) {
  const g = svg("g", { visibility: "hidden" });
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (COLORS[c]) g.append(svg("rect", { x: x * SCALE, y: y * SCALE, width: SCALE, height: SCALE, fill: COLORS[c] }));
  }));
  frames[name] = g;
  elf.append(g);
}
art.append(stem, leaves, elf);
box.append(art);
document.body.append(box);

const ELF_W = FRAMES.rest[0].length * SCALE, ELF_H = FRAMES.rest.length * SCALE;
const vineX = y => WIDTH / 2 + 5 * Math.sin(y / 42); // gently wavy
let height = 0, grown = 0, shown = "rest";
const show = name => {
  if (name === shown) return;
  frames[shown].setAttribute("visibility", "hidden");
  frames[(shown = name)].setAttribute("visibility", "visible");
};
show("left");
show("rest");

// The vine and its leaves, for the window's height
function draw() {
  height = innerHeight;
  art.setAttribute("height", height);
  let d = `M${vineX(0).toFixed(1)} 0`;
  for (let y = 4; y <= height; y += 4) d += `L${vineX(y).toFixed(1)} ${y}`;
  stem.setAttribute("d", d);
  leaves.replaceChildren();
  for (let y = LEAF_EVERY / 2, side = 1; y < height; y += LEAF_EVERY, side = -side) {
    const x = vineX(y);
    const leaf = svg("path", { class: "leaf", d: "M0 0q7 -7 15 -3q-7 7 -15 3z",
      transform: `translate(${x.toFixed(1)} ${y}) scale(${side} 1)` });
    leaf.dataset.y = y;
    leaves.append(leaf);
  }
}

// Where the page is scrolled: the elf there, the vine grown to there at least
let lastY = scrollY, travelled = 0, resting = 0;
function place() {
  const room = document.documentElement.scrollHeight - innerHeight;
  box.hidden = !wide.matches || room < 200; // nothing much to scroll: no vine
  if (box.hidden) return;
  const read = Math.min(1, Math.max(0, scrollY / room));
  grown = Math.max(grown, read);
  stem.style.strokeDashoffset = 1 - grown;
  const y = read * (height - ELF_H);
  elf.setAttribute("transform", `translate(${(vineX(y + ELF_H / 2) - ELF_W / 2).toFixed(1)} ${y.toFixed(1)})`);
  for (const leaf of leaves.children) leaf.classList.toggle("out", +leaf.dataset.y <= grown * height);
}

// Hand over hand: a step every so far scrolled, resting once the scrolling stops
function moved() {
  travelled += Math.abs(scrollY - lastY);
  lastY = scrollY;
  if (!still.matches) show(Math.floor(travelled / 22) % 2 ? "left" : "right");
  clearTimeout(resting);
  resting = setTimeout(() => show("rest"), 450);
}

let queued = false;
addEventListener("scroll", () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    place();
    if (!box.hidden) moved();
  });
}, { passive: true });
addEventListener("resize", () => { draw(); place(); });
wide.addEventListener("change", place);
// The page grows as it loads (results, deck lists): its length is checked again now and then
new ResizeObserver(place).observe(document.body);
draw();
place();
