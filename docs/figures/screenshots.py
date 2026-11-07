"""Take the README's screenshots of the site (dark mode, prices in US dollars) into docs/images/.
Needs the site built locally and served (python scripts/serve.py), and Playwright with Chromium:

    python docs/figures/screenshots.py [http://localhost:8000]
"""
import io
import json
import os
import sys
import urllib.request

from PIL import Image
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "images")
WIDTH = 1280

# Derevi's card number in the site's index (it changes as Scryfall's list grows), and a public
# Derevi deck from the site's own deck file, as a pasted decklist
with urllib.request.urlopen(f"{SITE}/index/names.json") as res:
    DEREVI = json.load(res).index("Derevi, Empyrial Tactician")
DECK = """async key => {
  const names = await (await fetch('index/names.json')).json();
  const shard = await (await fetch(`decks/${key}.json`)).json();
  let p = 0;
  const cards = shard.decks[5][3].map(gap => shard.cards[p += gap]);
  return ['1 Derevi, Empyrial Tactician *CMDR*', ...cards.map(c => '1 ' + names[c])].join(String.fromCharCode(10));
}"""


def save(page, name, clip):
    """The clipped part of the page, as a WebP small enough for a README"""
    shot = Image.open(io.BytesIO(page.screenshot(clip=clip, full_page=True)))
    shot.save(os.path.join(OUT, f"{name}.webp"), quality=82, method=6)


def settle(page, ms=2500):
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(ms)  # card images fade in


def at(locator):
    """Where an element is on the page (bounding_box is relative to the viewport, which may have scrolled)"""
    b = locator.bounding_box()
    return {**b, "y": b["y"] + locator.page.evaluate("scrollY")}


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": WIDTH, "height": 900}, color_scheme="dark")
    context.add_init_script("try { localStorage.setItem('currency', 'USD'); localStorage.removeItem('decklist') } catch {}")
    page = context.new_page()

    # 1. Search: the query, what it matched, and the first two rows of cards
    page.goto(f"{SITE}/?q=cheap+green+elves+that+ramp")
    page.wait_for_selector("#results .card")
    settle(page)
    rows = at(page.locator("#results .card").nth(6))
    save(page, "screenshot-search", {"x": 0, "y": 0, "width": WIDTH, "height": rows["y"] + rows["height"] + 16})

    # 2. Deck recommendations for a Derevi deck, matched with top-cut tournament decks
    page.goto(f"{SITE}/?deck&decks=topcut")
    page.fill("#decklist", page.evaluate(DECK, DEREVI))
    page.click("#deck-form button[type=submit]")
    page.wait_for_selector("#deck-results:not([hidden]) #adds .card")
    settle(page)
    top = at(page.locator("#deck-results"))["y"]
    first = at(page.locator("#adds .card").nth(4))
    save(page, "screenshot-deck", {"x": 0, "y": top - 16, "width": WIDTH, "height": first["y"] + first["height"] + 16 - top + 16})

    # 2b. Its packages: the commander's packages it runs, some only partly (a badge)
    page.click("#deck-views button:has-text('Packages')")
    page.wait_for_selector("#deck-packages svg .node")
    settle(page, 3000)
    top, box = at(page.locator("#deck-packages-as")), at(page.locator("#deck-packages"))
    save(page, "screenshot-deck-packages", {"x": box["x"] - 12, "y": top["y"] - 12, "width": box["width"] + 24,
                                            "height": box["y"] + box["height"] - top["y"] + 24})

    # 3. A commander page: builds, brackets and the top-cut average deck
    page.goto(f"{SITE}/?commander={DEREVI}&view=average&avg=topcut")
    page.wait_for_selector("#average .card")
    settle(page, 4000)
    first = at(page.locator("#average .card").first)
    save(page, "screenshot-commander", {"x": 0, "y": 200, "width": WIDTH, "height": first["y"] + first["height"] + 16 - 200})

    # 3b. Its tournament results: the cards decks that made the cut play differently from those that missed it
    page.goto(f"{SITE}/?commander={DEREVI}&view=tournaments")
    page.wait_for_selector("#results-parts button")
    page.click("#results-parts button:has-text('Made the cut')")
    page.wait_for_selector("#topcut-rows li.group")
    settle(page, 1500)
    top, rows = at(page.locator("#results-parts")), at(page.locator("#topcut-rows"))
    save(page, "screenshot-topcut", {"x": rows["x"] - 24, "y": top["y"] - 12, "width": rows["width"] + 48,
                                     "height": rows["y"] + rows["height"] - top["y"] + 24})

    # 3c. A card's synergy graph, opened from the commander's page (a taller window: the dialog's all in view)
    page.set_viewport_size({"width": WIDTH, "height": 1100})
    page.goto(f"{SITE}/?commander={DEREVI}")
    page.locator(".card:has(.card-name:text-is('Swords to Plowshares'))").first.click()
    page.click("#with-tabs button:has-text('Synergy')")
    page.wait_for_selector("#synergy svg .node")
    settle(page, 2500)
    page.mouse.move(0, 0)
    modal = page.locator("#modal").bounding_box()
    shot = Image.open(io.BytesIO(page.screenshot()))  # the dialog sits over the viewport, not the page
    shot.crop((int(modal["x"]), int(modal["y"]), int(modal["x"] + modal["width"]), int(modal["y"] + modal["height"])))         .save(os.path.join(OUT, "screenshot-synergy.webp"), quality=82, method=6)
    page.set_viewport_size({"width": WIDTH, "height": 900})

    # 3d. Its package map, a package pointed at; then that package's own graph
    page.goto(f"{SITE}/?commander={DEREVI}&view=combos")
    page.click("#combo-tabs button:has-text('Packages')")
    page.wait_for_selector("#packages-graph svg .node")
    settle(page, 3000)
    node = page.locator("#packages-graph g.node[aria-label^='Bloom Tender']")
    node.hover()
    page.wait_for_timeout(300)
    top, graph = at(page.locator("#packages-lede")), at(page.locator("#packages-graph"))
    save(page, "screenshot-packages", {"x": graph["x"] - 12, "y": top["y"] - 12, "width": graph["width"] + 24,
                                       "height": graph["y"] + graph["height"] - top["y"] + 24})
    node.click()
    page.wait_for_selector("#packages-graph .graph-crumbs")
    settle(page, 2500)
    page.mouse.move(0, 0)
    graph = at(page.locator("#packages-graph"))
    save(page, "screenshot-package", {"x": graph["x"] - 12, "y": graph["y"] - 12, "width": graph["width"] + 24, "height": graph["height"] + 24})

    # 4. Tournaments: the last 30 days' highlights, the period's numbers and the commanders' table
    page.goto(f"{SITE}/?tournaments")
    page.wait_for_selector("table tbody tr")
    settle(page)
    row = at(page.locator("table tbody tr").nth(5))
    save(page, "screenshot-tournaments", {"x": 0, "y": 200, "width": WIDTH, "height": row["y"] + row["height"] - 200})

    # 5. A card's details: its price history, every day since its printing
    page.goto(f"{SITE}/?q=Smothering+Tithe")
    page.wait_for_selector("#results .card")
    settle(page, 1500)
    page.locator("#results .card").first.click()
    page.wait_for_selector("#history-ranges button")
    page.locator("#history-ranges button", has_text="All").click()
    page.wait_for_timeout(1500)
    modal = page.locator("#modal").bounding_box()
    note = page.locator("#history-note").bounding_box()
    shot = Image.open(io.BytesIO(page.screenshot()))  # the dialog sits over the viewport, not the page
    shot.crop((int(modal["x"]), int(modal["y"]), int(modal["x"] + modal["width"]), int(note["y"] + note["height"] + 24))) \
        .save(os.path.join(OUT, "screenshot-prices.webp"), quality=82, method=6)
    browser.close()
print("Wrote", OUT)
