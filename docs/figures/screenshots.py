"""Take the README's screenshots of the site (dark mode, prices in US dollars) into docs/images/.
Needs the site built locally and served (python scripts/serve.py), and Playwright with Chromium:

    python docs/figures/screenshots.py [http://localhost:8000]
"""
import io
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "images")
WIDTH = 1280

# A public Derevi deck from the site's own deck file, as a pasted decklist
DEREVI = 2961
DECK = """async () => {
  const names = await (await fetch('index/names.json')).json();
  const shard = await (await fetch('decks/2961.json')).json();
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
    page.fill("#decklist", page.evaluate(DECK))
    page.click("#deck-form button[type=submit]")
    page.wait_for_selector("#deck-results:not([hidden]) #adds .card")
    settle(page)
    top = at(page.locator("#deck-results"))["y"]
    first = at(page.locator("#adds .card").nth(4))
    save(page, "screenshot-deck", {"x": 0, "y": top - 16, "width": WIDTH, "height": first["y"] + first["height"] + 16 - top + 16})

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
