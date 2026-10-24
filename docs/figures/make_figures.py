"""Draw the README's diagrams and charts into docs/images/, each in a light and a dark version (the
README shows the one matching the reader's GitHub theme), from the numbers site_data.mjs works out
with the site's own code. Needs the site built locally (scripts/build_index.py, then
scripts/build_decks.py build), Node, matplotlib and scikit-learn:

    python docs/figures/make_figures.py
"""
import json
import math
import os
import subprocess
from html import escape

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.manifold import TSNE

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "images")
FONT = "Georgia, 'Times New Roman', serif"

# The site's colors (site/index.html), plus two richer marks for charts (checked for color blindness
# with the dataviz palette validator: they differ in lightness too, and always come with labels)
THEMES = {
    "light": dict(bg="#faf4e6", panel="#f1e7d2", panel2="#e7dabe", ink="#2b1e14", soft="#6a5440", faint="#8f7a63",
                  rule="#d5c19b", accent="#26804a", accent_soft="#dfe7d6", amber="#c07a12", amber_soft="#f3e1bf",
                  ramp=["#9cc5a5", "#5a9a6c", "#26804a"]),
    "dark": dict(bg="#231b15", panel="#2b2119", panel2="#36291f", ink="#ecdfc8", soft="#bba586", faint="#8c7860",
                 rule="#4a3929", accent="#45a066", accent_soft="#2c3a2b", amber="#c4832a", amber_soft="#3d2e1a",
                 ramp=["#2f6b41", "#3d8a55", "#6cbd85"]),
}


def site_data():
    out = subprocess.run(["node", os.path.join(HERE, "site_data.mjs")], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def save_svg(name, mode, svg):
    with open(os.path.join(OUT, f"{name}-{mode}.svg"), "w", encoding="utf-8", newline="\n") as f:
        f.write(svg)


# === Hand-drawn diagrams (SVG) ===

class Svg:
    def __init__(self, w, h, t):
        self.w, self.h, self.t, self.parts = w, h, t, []

    def rect(self, x, y, w, h, fill=None, stroke=None, rx=8, dash=False, sw=1.2):
        dashes = ' stroke-dasharray="4 3"' if dash else ""
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" fill="{fill or "none"}"'
                          f' stroke="{stroke or "none"}" stroke-width="{sw}"{dashes}/>')

    def text(self, x, y, s, size=14, fill=None, anchor="start", weight="normal", italic=False):
        slant = ' font-style="italic"' if italic else ""
        self.parts.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill or self.t["ink"]}" text-anchor="{anchor}"'
                          f' font-weight="{weight}"{slant}>{escape(s)}</text>')

    def arrow(self, x1, y1, x2, y2, color=None, dash=False):
        c = color or self.t["faint"]
        dashes = ' stroke-dasharray="5 4"' if dash else ""
        self.parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c}" stroke-width="1.6"{dashes}'
                          ' marker-end="url(#head)"/>')

    def render(self):
        t = self.t
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}"'
                f' font-family="{FONT}">\n'
                f'<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                f'<path d="M0,0 L10,5 L0,10 z" fill="{t["faint"]}"/></marker></defs>\n'
                f'<rect width="100%" height="100%" rx="10" fill="{t["bg"]}"/>\n' + "\n".join(self.parts) + "\n</svg>\n")


def box(s, x, y, w, h, title, sub=None, fill=None, title_size=14):
    s.rect(x, y, w, h, fill or s.t["panel"], s.t["rule"])
    if sub:
        s.text(x + w / 2, y + h / 2 - 3, title, title_size, anchor="middle", weight="bold")
        s.text(x + w / 2, y + h / 2 + 15, sub, 12, s.t["soft"], anchor="middle")
    else:
        s.text(x + w / 2, y + h / 2 + 5, title, title_size, anchor="middle", weight="bold")


def pipeline(t):
    """7. Where the data comes from, what turns it into the site, and where it runs"""
    s = Svg(960, 560, t)
    cols = [(20, 200, "Sources"), (265, 190, "Scripts (scripts/)"), (500, 200, "Kept in data/ and releases"),
            (745, 195, "Built into site/")]
    for x, w, head in cols:
        s.text(x + w / 2, 34, head, 13, t["soft"], anchor="middle", weight="bold")
    rows = [
        (("Scryfall", "cards, tags, printings"), ("build_index.py", "a vector per card"),
         ("oracle_cards, default_cards", "downloaded fresh"), ("site/index/", "the search index")),
        (("Archidekt, Moxfield", "public Commander decks"), ("build_decks.py crawl", "one request a second"),
         ("decks.jsonl.gz", "deck-corpus release"), ("site/decks/", "commanders, builds, trends")),
        (("edhtop16", "cEDH tournament results"), ("build_decks.py results", "two years of events"),
         ("results.jsonl.gz", "deck-corpus release"), ("site/decks/results/", "win rates, top cuts")),
        (("Scryfall, price archives", "every printing's price"), ("build_prices.py", "daily snapshots, backfill"),
         ("prices.jsonl.gz", "price-history release"), ("site/prices/", "charts, movers")),
    ]
    for r, cells in enumerate(rows):
        y = 52 + r * 84
        for (x, w, _), (title, sub) in zip(cols, cells):
            box(s, x, y, w, 62, title, sub)
        for (x1, w1, _), (x2, _, _) in zip(cols, cols[1:]):
            s.arrow(x1 + w1 + 4, y + 31, x2 - 6, y + 31)
    # Deploy: site/ to Pages, to the browser; a pasted link through the worker
    y = 420
    s.rect(745, 52, 195, 330, None, t["faint"], dash=True)
    s.arrow(842, 386, 842, y - 6)
    box(s, 745, y, 195, 62, "GitHub Pages", "serves site/ as static files")
    s.arrow(741, y + 31, 600, y + 31)
    box(s, 380, y, 216, 62, "Your browser", "search.js, deck.js do the work")
    s.arrow(150, y + 31, 376, y + 31)
    box(s, 20, y, 126, 62, "deck-link.js", "Cloudflare Worker")
    s.text(263, y + 20, "a pasted deck link", 12, t["soft"], anchor="middle", italic=True)
    s.text(480, 522, "GitHub Actions: crawl.yml every day (decks, tournaments, a day of prices, then a deploy) · "
           "deploy.yml rebuilds everything", 12, t["soft"], anchor="middle")
    s.text(480, 542, "No server, no database: the heavy work happens at build time, and a search downloads only the "
           "pieces of the index it needs.", 12, t["soft"], anchor="middle")
    return s.render()


def search_coverage(t, d):
    """8. A query as weighted term groups, and the share of it each card covers"""
    q = d["search"]
    order = sorted(range(len(q["groups"])), key=lambda i: -q["groups"][i]["weight"])
    groups = [q["groups"][i] for i in order]
    total = sum(g["weight"] for g in groups)
    names = {"tag:ramp": "ramp", "G": "green", "Elf": "Elf"}
    label = lambda g: names.get(g["terms"][0], "cheap") if len(g["terms"]) == 1 else "cheap"
    detail = lambda g: "mana value 0–3" if len(g["terms"]) > 1 else f'{g["cardsWith"]:,} cards'

    s = Svg(900, 400, t)
    s.rect(250, 18, 400, 40, t["panel"], t["rule"], rx=20)
    s.text(450, 44, f'“{q["query"]}”', 17, anchor="middle", italic=True)
    s.arrow(450, 62, 450, 84)
    x0, width, top = 200, 560, 92
    xs = [x0]
    for g in groups:
        xs.append(xs[-1] + width * g["weight"] / total)
    for g, a, b in zip(groups, xs, xs[1:]):
        s.text((a + b) / 2, top + 16, label(g), 14, anchor="middle", weight="bold")
        s.text((a + b) / 2, top + 33, f'weight {g["weight"]:.1f}', 12, t["soft"], anchor="middle")
        s.text((a + b) / 2, top + 48, detail(g), 11, t["faint"], anchor="middle")
    s.text(x0 - 12, top + 33, "query terms", 12, t["soft"], anchor="end")
    s.text(x0 + width + 16, top + 33, "score", 12, t["soft"])
    for r, ex in enumerate(q["examples"]):
        y = top + 64 + r * 46
        covers = [ex["covers"][i] for i in order]
        s.text(x0 - 12, y + 25, ex["name"], 14, anchor="end")
        for c, a, b in zip(covers, xs, xs[1:]):
            if c:
                s.rect(a + 2, y + 4, b - a - 4, 32, t["accent_soft"], t["accent"], rx=5)
                s.text((a + b) / 2, y + 25, "✓", 15, t["accent"], anchor="middle")
            else:
                s.rect(a + 2, y + 4, b - a - 4, 32, None, t["rule"], rx=5, dash=True)
        s.text(x0 + width + 16, y + 26, f'{ex["score"]:.0%}', 16, weight="bold")
    s.text(450, 362, f'A term\'s weight is (1 + ln({q["cards"]:,} cards ÷ cards with it))², so rare terms count for more: '
           f'Elf (694 cards) counts 3.5× green.', 12, t["soft"], anchor="middle")
    s.text(450, 382, "A card scores the share of the query's weight it covers. Extra features the query didn't ask "
           "for don't count against it; ties go to the more popular card.", 12, t["soft"], anchor="middle")
    return s.render()


def card_weights(k):
    """How much each of the commander's cards counts toward two decks being alike (deck.js's weight)"""
    n = k["decks"]
    return [math.log(n / max(c["plays"], 1)) ** 2 for c in k["cards"]]


def shared_cards(t, d):
    """9. Two decks that share staples barely look alike; two that share rare picks do"""
    k = d["kinnan"]
    n, cards, weight = k["decks"], k["cards"], card_weights(k)
    norm = float(np.median([sum(weight[p] for p in deck) for deck in k["deckCards"]]))
    spells = [p for p, c in enumerate(cards) if not c["land"]]
    staples = sorted(spells, key=lambda p: -cards[p]["plays"])[:6]
    rare = sorted((p for p in spells if 0.03 <= cards[p]["plays"] / n <= 0.06), key=lambda p: cards[p]["popularity"])[:3]

    s = Svg(900, 350, t)
    s.text(450, 32, f'Two {k["name"]} decks that share these cards, and nothing else:', 15, anchor="middle", weight="bold")
    for col, (picks, head) in enumerate([(staples, "6 cards almost every deck plays"), (rare, "3 cards few decks play")]):
        x = 30 + col * 440
        s.text(x + 200, 66, head, 14, t["soft"], anchor="middle", weight="bold")
        for i, p in enumerate(picks):
            y = 80 + i * 30
            s.rect(x, y, 400, 24, t["panel"], t["rule"], rx=5)
            s.text(x + 10, y + 17, cards[p]["name"], 13)
            s.text(x + 268, y + 17, f'{cards[p]["plays"] / n:.0%} of decks', 12, t["soft"], anchor="end")
            s.text(x + 390, y + 17, f'counts {weight[p]:.2f}', 12, t["accent"] if weight[p] > 1 else t["faint"], anchor="end")
        alike = sum(weight[p] for p in picks) / norm
        y = 80 + 6 * 30 + 8
        s.text(x + 200, y + 10, f"{alike:.0%} alike" if alike >= 0.01 else "under 1% alike", 22, anchor="middle", weight="bold")
    s.text(450, 318, f"A shared card counts ln({n:,} decks ÷ decks that play it)². Two decks are as alike as their shared "
           f"cards' total over their own", 12, t["soft"], anchor="middle")
    s.text(450, 336, f"(cosine similarity, here with two typical {k['name'].split(',')[0]} decks): sharing Sol Ring says "
           "nothing about a deck; sharing a rare pick says a lot.", 12, t["soft"], anchor="middle")
    return s.render()


def recommend_vote(t, d):
    """10. The decks most like yours vote for the cards they play that yours doesn't, staples discounted"""
    k = d["kinnan"]
    ex = k["example"]
    shown = sorted([a for a in ex["adds"] if a["name"] in ("Botanical Sanctum", "Twincast", "Pia, Aether Ascetic",
                                                             "Whir of Invention")], key=lambda a: -a["score"])
    s = Svg(900, 400, t)
    box(s, 20, 150, 150, 70, "Your deck", f'{ex["cards"]} cards, {k["name"].split(",")[0]}')
    s.arrow(174, 185, 220, 185)
    for i, c in enumerate(ex["closest"][:4]):
        y = 60 + i * 56
        s.rect(226, y, 170, 44, t["panel"], t["rule"])
        s.text(311, y + 20, f'{c["similarity"]:.0%} alike', 14, anchor="middle", weight="bold")
        s.text(311, y + 36, f'{c["shared"]} cards in common', 11, t["soft"], anchor="middle")
    s.text(311, 300, f'… the {ex["neighbors"]} most alike decks', 12, t["soft"], anchor="middle", italic=True)
    s.arrow(400, 185, 440, 185)
    # Each card: its share of the votes, less a discount for how many of all the decks play it
    x0, scale = 600, 200
    s.text(446, 34, "Cards they play that yours doesn't", 14, weight="bold")
    s.rect(446, 48, 12, 12, t["accent"], None, rx=2)
    s.text(464, 58, "share of the votes, more alike decks counting more", 11, t["soft"])
    s.rect(446, 64, 12, 12, t["amber_soft"], t["amber"], rx=2, dash=True)
    s.text(464, 74, "less half the share of all decks that play it" if k["discount"] == 0.5
           else f"less {k['discount']:g} × the share of all decks that play it", 11, t["soft"])
    for i, a in enumerate(shown):
        y = 92 + i * 56
        s.text(x0 - 12, y + 18, a["name"], 13, anchor="end")
        s.text(x0 - 12, y + 34, f'{a["everywhere"]:.0%} of all decks play it', 11, t["faint"], anchor="end")
        net, cut = a["score"] * scale, k["discount"] * a["everywhere"] * scale
        s.rect(x0, y + 4, net, 26, t["accent"], None, rx=3)
        s.rect(x0 + net, y + 4, cut, 26, t["amber_soft"], t["amber"], rx=3, dash=True)
        s.text(x0 + net + cut + 8, y + 22, f'{a["share"]:.0%} − {k["discount"] * a["everywhere"]:.0%} = {a["score"]:.2f}', 12,
               weight="bold")
    s.text(450, 340, f'Pia gets more of the votes than Twincast ({shown[2]["share"]:.0%} against {shown[1]["share"]:.0%}), '
           f'but {shown[2]["everywhere"]:.0%} of all Kinnan decks play it and {shown[1]["everywhere"]:.0%} play Twincast,',
           12, t["soft"], anchor="middle")
    s.text(450, 358, "so Twincast ranks higher: cards to add are what decks like yours play more than usual, not just "
           "staples. Your cards they rarely play are cards to cut.", 12, t["soft"], anchor="middle")
    s.text(450, 384, "A real Kinnan deck from Moxfield or Archidekt, matched with the commander's other public decks.",
           11, t["faint"], anchor="middle", italic=True)
    return s.render()


# === Charts (matplotlib) ===

def style(t):
    plt.rcParams.update({
        "font.family": "serif", "font.serif": ["Georgia", "DejaVu Serif"], "font.size": 11,
        "figure.facecolor": t["bg"], "axes.facecolor": t["bg"], "savefig.facecolor": t["bg"],
        "axes.edgecolor": t["rule"], "axes.labelcolor": t["soft"], "text.color": t["ink"],
        "xtick.color": t["soft"], "ytick.color": t["soft"], "grid.color": t["rule"], "grid.linewidth": 0.6,
        "axes.spines.top": False, "axes.spines.right": False, "svg.hashsalt": "mtg-vec2search",
    })


def save_chart(fig, name, mode):
    fig.savefig(os.path.join(OUT, f"{name}-{mode}.svg"), format="svg", metadata={"Date": None}, bbox_inches="tight",
                dpi=150)
    plt.close(fig)


def deck_map(k):
    """Each deck as a point: the cards it plays (lands left out, rare ones counting more, as findBuilds
    weighs them), laid out in 2D so alike decks sit together"""
    n, cards = k["decks"], k["cards"]
    rare = max(2, 0.02 * n)
    idf = np.array([math.log(n / c["plays"]) if c["plays"] >= rare and not c["land"] else 0 for c in cards])
    x = np.zeros((n, len(cards)))
    for d, deck in enumerate(k["deckCards"]):
        x[d, deck] = idf[deck]
    x /= np.linalg.norm(x, axis=1, keepdims=True) + 1e-9
    x = TruncatedSVD(30, random_state=1).fit_transform(x)
    return TSNE(2, random_state=1, init="pca", perplexity=40, metric="cosine").fit_transform(x)


def builds_chart(t, mode, d, xy):
    """11. The commander's decks, one panel per build the site finds, the build's decks colored"""
    k = d["kinnan"]
    n = k["decks"]
    panels = [("All decks", None)] + [(b["name"], set(b["members"])) for b in k["builds"]]
    fig, axes = plt.subplots(2, 3, figsize=(9, 6.2))
    for ax, (name, members) in zip(axes.flat, panels):
        ax.set_xticks([]), ax.set_yticks([])
        for side in ax.spines.values():
            side.set_visible(False)
        ax.set_facecolor(t["panel"])
        if members is None:
            ax.scatter(xy[:, 0], xy[:, 1], s=7, color=t["soft"], linewidths=0, rasterized=True)
            ax.set_title(f"All decks ({n:,})", fontsize=12, color=t["ink"], loc="left")
            continue
        inside = np.array([i in members for i in range(n)])
        ax.scatter(xy[~inside, 0], xy[~inside, 1], s=6, color=t["panel2"], linewidths=0, rasterized=True)
        ax.scatter(xy[inside, 0], xy[inside, 1], s=8, color=t["accent"], linewidths=0, rasterized=True)
        ax.set_title(f"{name}: {inside.sum() / n:.0%} ({inside.sum():,})", fontsize=12, color=t["ink"], loc="left")
    fig.suptitle(f"{k['name']}: {n:,} public decks, split into builds by the cards they play",
                 x=0.02, ha="left", fontsize=14, color=t["ink"])
    fig.text(0.02, -0.01, "Each dot is a deck; decks that play alike cards sit together (a t-SNE map of the same "
             "card weights the site groups them by). Lands are left out.", fontsize=10, color=t["soft"])
    fig.tight_layout(rect=(0, 0.02, 1, 0.97))
    save_chart(fig, "builds", mode)


def weights_chart(t, mode, d):
    """12. How much sharing a card counts, by how many of the commander's decks play it"""
    k = d["kinnan"]
    n, cards, weight = k["decks"], k["cards"], card_weights(k)
    fig, ax = plt.subplots(figsize=(9, 4.4))
    share = np.logspace(math.log10(1 / n), 0, 200)
    ax.plot(share * 100, np.log(1 / share) ** 2, color=t["accent"], linewidth=2)
    # A well-known card near each share, and where its label goes (offset in points, alignment): the
    # flat end of the curve is crowded, so the two there sit higher, pointing down to their cards
    picked = []
    for target, offset, ha in ((0.97, (-6, 96), "right"), (0.3, (8, 46), "left"), (0.05, (10, 8), "left"),
                               (0.01, (10, 8), "left"), (0.002, (10, 8), "left")):
        near = [p for p, c in enumerate(cards) if not c["land"] and abs(math.log(c["plays"] / n / target)) < 0.2
                and p not in [q for q, _, _ in picked]]
        if near:
            picked.append((min(near, key=lambda p: cards[p]["popularity"]), offset, ha))
    for p, offset, ha in picked:
        x, y = cards[p]["plays"] / n * 100, weight[p]
        ax.scatter([x], [y], s=46, color=t["accent"], edgecolors=t["bg"], linewidths=2, zorder=3)
        ax.annotate(f'{cards[p]["name"]}\n{x:.0f}% of decks · counts {y:.1f}' if x >= 1 else
                    f'{cards[p]["name"]}\n{x:.1f}% of decks · counts {y:.1f}', (x, y), xytext=offset, ha=ha,
                    textcoords="offset points", fontsize=9.5, color=t["ink"],
                    arrowprops=dict(arrowstyle="-", color=t["faint"], linewidth=0.8) if offset[1] > 20 else None)
    ax.set_xscale("log")
    ax.set_xticks([0.1, 1, 10, 100], ["0.1%", "1%", "10%", "100%"])
    ax.set_xlabel(f"Share of {k['name'].split(',')[0]} decks that play the card (log scale; {n:,} decks)")
    ax.set_ylabel("How much sharing it counts")
    ax.grid(axis="y")
    ax.set_title("A card every deck plays counts for nothing; a rare pick counts a lot", loc="left", fontsize=13)
    fig.tight_layout()
    save_chart(fig, "card-weights", mode)


def shrinkage_chart(t, mode, d):
    """13. What a real difference in win rate shows as, by how many games the card's decks played"""
    k = d["kinnan"]
    rate, total, prior = k["rate"], k["games"], k["priorGames"]
    fig, ax = plt.subplots(figsize=(9, 4.4))
    games = np.logspace(1, 4, 300)
    for diff, color in zip((0.02, 0.05, 0.10), t["ramp"]):
        shown = diff * games / (games + prior) * 100
        evidence = diff / np.sqrt(2 * rate * (1 - rate) * (1 / games + 1 / (total - games)))
        sure = evidence >= 2
        ax.plot(games[~sure], shown[~sure], color=color, linewidth=2, linestyle=(0, (3, 3)))
        ax.plot(games[sure], shown[sure], color=color, linewidth=2)
        ax.axhline(diff * 100, color=t["rule"], linewidth=0.8, zorder=0)
        ax.annotate(f"really +{diff * 100:.0f} pts", (games[-1], shown[-1]), xytext=(6, -4), textcoords="offset points",
                    fontsize=10, color=t["ink"])
    ax.set_xscale("log")
    ax.set_xticks([10, 100, 1000, 10000], ["10", "100", "1,000", "10,000"])
    ax.set_xlabel("Tournament games played by the decks with the card (log scale)")
    ax.set_ylabel("Difference the site shows (pts)")
    ax.set_ylim(0, 11)
    ax.grid(axis="y")
    ax.set_title("A card few decks play needs a big difference to show one", loc="left", fontsize=13)
    fig.text(0.01, -0.04, f"Both sides are pulled toward the commander's win rate ({rate:.1%} for Kinnan) by {prior} games' "
             "worth. Dashed: under 2 standard errors, shown faded on the site.", fontsize=10, color=t["soft"])
    fig.tight_layout()
    save_chart(fig, "shrinkage", mode)


def public_vs_topcut_chart(t, mode, d):
    """14. The cards whose play rates differ most between public decks and top-cut tournament decks"""
    k = d["kinnan"]
    n, top = k["decks"], k["topCutDecks"]
    rows = [(c["name"], c["plays"] / n, c["topCut"] / top) for c in k["cards"]
            if max(c["plays"] / n, c["topCut"] / top) >= 0.15]
    rows.sort(key=lambda r: r[2] - r[1])
    rows = rows[:5] + rows[-7:]
    fig, ax = plt.subplots(figsize=(9, 5.4))
    for y, (name, pub, cut) in enumerate(rows):
        ax.plot([pub * 100, cut * 100], [y, y], color=t["rule"], linewidth=2, zorder=1)
        ax.scatter([pub * 100], [y], s=60, facecolors=t["bg"], edgecolors=t["amber"], linewidths=2, zorder=2)
        ax.scatter([cut * 100], [y], s=60, color=t["accent"], zorder=3)
    ax.set_yticks(range(len(rows)), [r[0] for r in rows])
    ax.axhline(4.5, color=t["rule"], linewidth=0.8, linestyle=(0, (4, 3)))
    ax.set_xlim(0, 100)
    ax.set_xticks(range(0, 101, 20), [f"{x}%" for x in range(0, 101, 20)])
    ax.set_xlabel("Share of decks that play the card")
    ax.grid(axis="x")
    ax.scatter([], [], s=60, facecolors=t["bg"], edgecolors=t["amber"], linewidths=2, label=f"Public decks ({n:,})")
    ax.scatter([], [], s=60, color=t["accent"], label=f"Top-cut tournament decks ({top:,})")
    ax.legend(loc="upper center", bbox_to_anchor=(0.4, -0.12), ncol=2, frameon=False, fontsize=10)
    ax.text(102, 8, "Top-cut decks\nplay more", ha="left", va="center", fontsize=10, color=t["soft"], clip_on=False)
    ax.text(102, 2, "Top-cut decks\nplay less", ha="left", va="center", fontsize=10, color=t["soft"], clip_on=False)
    ax.set_title(f"{k['name']}: what top-cut decks play more, and less, than public ones", loc="left", fontsize=13)
    fig.tight_layout()
    save_chart(fig, "public-vs-topcut", mode)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    data = site_data()
    xy = deck_map(data["kinnan"])
    for mode, theme in THEMES.items():
        save_svg("pipeline", mode, pipeline(theme))
        save_svg("search", mode, search_coverage(theme, data))
        save_svg("shared-cards", mode, shared_cards(theme, data))
        save_svg("recommend", mode, recommend_vote(theme, data))
        style(theme)
        builds_chart(theme, mode, data, xy)
        weights_chart(theme, mode, data)
        shrinkage_chart(theme, mode, data)
        public_vs_topcut_chart(theme, mode, data)
    print("Wrote", OUT)
