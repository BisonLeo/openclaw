---
name: jd-search-scraper
description: Scrape JD.com (京东) product search results into Excel. Extracts title, price, original price, features, sold count, store name, and product URL. Use when the user wants to search JD.com for products and export results to spreadsheet. Requires Chrome running with --remote-debugging-port=9222 on the Playclaw profile, configured as the vnc-chrome browser profile in openclaw.json.
---

# JD.com Search Scraper

Scrape product listings from JD.com search results into JSON → Excel using the **built-in browser tool** (profile: `vnc-chrome`).

## Prerequisites

- Chrome running with `--remote-debugging-port=9222` (Playclaw profile)
- `vnc-chrome` browser profile configured in `~/.openclaw/openclaw.json`
- `openpyxl` for Python Excel generation (`pip install openpyxl`)

## Agent Workflow (browser tool — no Node.js WS needed)

This skill is **agent-driven**: the agent uses the `browser` tool directly. No external script required for browser interaction. The `json_to_xlsx.py` script is still used for Excel output.

### Step 1 — Ensure Chrome is running

```bash
ss -tlnp | grep 9222 || (
  nohup bash -c 'DISPLAY=:1 XAUTHORITY=/home/leo/.Xauthority google-chrome \
    --user-data-dir=/home/leo/.config/google-chrome-playclaw \
    --remote-debugging-port=9222 --no-first-run --no-default-browser-check \
    --disable-notifications "about:blank" &>>/tmp/chrome_playclaw.log' &
  sleep 6
)
```

### Step 2 — Get tab ID

```
browser(action="tabs", profile="vnc-chrome")
→ grab targetId of the page tab
```

### Step 3 — Navigate to search results

```
browser(action="navigate", profile="vnc-chrome", targetId=<id>,
        url="https://search.jd.com/Search?keyword=ENCODED&enc=utf-8")
```

Wait ~3 seconds after navigation.

### Step 4 — For each page (repeat for p = 1..N):

**a) Scroll to trigger lazy loading:**

```
browser(action="act", profile="vnc-chrome", targetId=<id>, request={
  kind: "evaluate",
  fn: "(async()=>{for(let i=0;i<18;i++){window.scrollBy(0,500);await new Promise(r=>setTimeout(r,300))}window.scrollTo(0,document.body.scrollHeight);await new Promise(r=>setTimeout(r,1500));window.scrollTo(0,0);return document.querySelectorAll('[class*=\"goodsCardWrapper\"]').length+''})()"
})
```

**b) Extract product cards:**

```
browser(action="act", profile="vnc-chrome", targetId=<id>, request={
  kind: "evaluate",
  fn: EXTRACT_FN   ← see below
})
→ returns JSON string of items array
```

**c) Click next page (skip for page 1):**

```
browser(action="act", profile="vnc-chrome", targetId=<id>, request={
  kind: "evaluate",
  fn: "(()=>{const pagi=document.querySelector('[class*=\"pagiContainer\"]');if(!pagi)return 'no pagi';for(const btn of pagi.querySelectorAll('[class*=\"pagination_item\"]')){if(btn.textContent.trim()==='2'&&!btn.className.includes('active')){btn.click();return 'clicked 2'}}return 'not found'})()"
})
```

Wait ~5 seconds after clicking, then repeat from step 4a for next page.

### Step 5 — Deduplicate and save JSON

Deduplicate by `url+title`. Save to `/home/leo/.openclaw/workspace/garmin_YYYY-MM-DD.json`.

### Step 6 — Convert to Excel

```bash
python3 /home/leo/openclaw/skills/jd-search-scraper/scripts/json_to_xlsx.py \
  /tmp/jd_results.json \
  /home/leo/.openclaw/workspace/garmin_YYYY-MM-DD.xlsx \
  CC0000
```

---

## EXTRACT_FN (JavaScript for evaluate)

```javascript
(() => {
  const items = [];
  document.querySelectorAll('[class*="goodsCardWrapper"]').forEach((card) => {
    try {
      const titleEl = card.querySelector('[class*="goods_title_container"] span[title]');
      const title = (titleEl?.getAttribute("title") || titleEl?.textContent || "").trim();
      if (!title) return;
      const pc = card.querySelector('[class*="container_d0rf6"],[class*="priceConter"]');
      const pe = pc?.querySelector('[class*="price_d0rf6"],[class*="price_t0dwj"]');
      let price = "";
      if (pe) {
        const y = pe.querySelector('[class*="yen"]')?.textContent || "";
        const m = pe.childNodes[1]?.textContent || "";
        const d = pe.querySelector('[class*="decimal"]')?.textContent || "";
        price = y + m + (d ? "." + d : "");
      }
      const oe = pc?.querySelector('[class*="gray"],[class*="origin"],del,s');
      const origPrice = (oe?.textContent || "").replace(/[^0-9.]/g, "").trim();
      const feats = [];
      card
        .querySelectorAll('[class*="text-list"] span,[class*="common-wrap"] span[title]')
        .forEach((s) => {
          const t = s.textContent.replace(/[|"]/g, "").trim();
          if (t && t.length < 30 && !t.includes("榜") && !t.includes("补贴")) feats.push(t);
        });
      const sold = (card.querySelector('[class*="goods_volume"]')?.textContent || "").trim();
      const store = (card.querySelector('[class*="shopFloor"]')?.textContent || "").trim();
      let url = "";
      const cl = card.querySelector('a[href*="chat.jd.com"]');
      if (cl) {
        const pid = cl.href.match(/pid=(\d+)/)?.[1];
        if (pid) url = "https://item.jd.com/" + pid + ".html";
      }
      items.push({ title, price, origPrice, features: feats.join(", "), sold, store, url });
    } catch (e) {}
  });
  return JSON.stringify(items);
})();
```

---

## CSS Selectors Reference

| Element         | Selector                                                  |
| --------------- | --------------------------------------------------------- |
| Product cards   | `[class*="goodsCardWrapper"]`                             |
| Title           | `[class*="goods_title_container"] span[title]`            |
| Price container | `[class*="container_d0rf6"]` or `[class*="priceConter"]`  |
| Price           | `[class*="price_d0rf6"]` or `[class*="price_t0dwj"]`      |
| Original price  | `[class*="gray"]`, `[class*="origin"]`, `del`, `s`        |
| Sales count     | `[class*="goods_volume"]`                                 |
| Store name      | `[class*="shopFloor"]`                                    |
| Pagination      | `[class*="pagiContainer"]` → `[class*="pagination_item"]` |
| Active page     | `[class*="active"]` on pagination item                    |

> JD uses CSS module hashed class names (e.g. `_price_d0rf6_14`). All selectors use `[class*="..."]` partial match for resilience against hash changes.

## Output fields

| Field     | Description                      |
| --------- | -------------------------------- |
| title     | Product name                     |
| price     | Current price (with ¥)           |
| origPrice | Original/crossed-out price       |
| features  | Feature tags joined by `, `      |
| sold      | Sales count text                 |
| store     | Shop name                        |
| url       | `https://item.jd.com/{pid}.html` |
| page      | Search result page number        |
| rank      | Position on that page            |

## Notes

- JD repeats promoted items across pages — always deduplicate by `url+title`.
- If the page tab is not found, ensure Chrome is launched with `--remote-debugging-port=9222`.
- The `vnc-chrome` profile must be set in `~/.openclaw/openclaw.json` with `cdpUrl: "http://127.0.0.1:9222"`.
- The old raw WebSocket CDP approach (`/tmp/node_modules/ws`) is deprecated in favour of the built-in browser tool.
