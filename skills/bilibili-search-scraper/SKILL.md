---
name: bilibili-search-scraper
description: Scrape Bilibili (B站) video search results into Excel. Extracts title, author, views, danmaku, duration, publish date, and video URL. Use when the user wants to search Bilibili for videos and export results to spreadsheet. Requires Chrome running with --remote-debugging-port=9222 configured as the vnc-chrome browser profile.
---

# Bilibili Search Scraper

Fetch video search results from Bilibili's API into JSON → Excel using the **built-in browser tool** (profile: `vnc-chrome`).

## Prerequisites

- Chrome running with `--remote-debugging-port=9222` (Playclaw profile)
- `vnc-chrome` browser profile in `~/.openclaw/openclaw.json`
- Chrome tab must be on bilibili.com (for cookie auth) — navigate there first
- `openpyxl` for Python Excel generation (`pip install openpyxl`)

## Agent Workflow (browser tool — no Node.js WS needed)

This skill is **agent-driven**: the agent calls `browser` tool actions directly. No external script required.

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

### Step 2 — Navigate to bilibili.com (for cookie context)

```
browser(action="tabs", profile="vnc-chrome")
→ grab targetId

browser(action="navigate", profile="vnc-chrome", targetId=<id>,
        url="https://www.bilibili.com")
```

Wait ~2 seconds.

### Step 3 — Fetch each page via API

For each page p = 1..N, run this evaluate in the bilibili.com tab:

```
browser(action="act", profile="vnc-chrome", targetId=<id>, request={
  kind: "evaluate",
  fn: FETCH_PAGE_FN(keyword, page, order)
})
→ returns JSON string of items array
```

**Why API instead of DOM:** Bilibili renders search results as Vue component shells — the card divs are empty skeletons. The API (`/x/web-interface/search/type`) with `credentials:'include'` uses the browser's Bilibili cookies and is 100% reliable.

### Step 4 — Collect, format, save JSON

Accumulate results across pages, add `page` and `rank` fields, format `pubdate` from Unix timestamp.
Save to `/home/leo/.openclaw/workspace/garmin_bili_YYYY-MM-DD.json`.

### Step 5 — Convert to Excel

```bash
python3 /home/leo/openclaw/skills/bilibili-search-scraper/scripts/json_to_xlsx.py \
  /tmp/bili_results.json \
  /home/leo/.openclaw/workspace/garmin_bili_YYYY-MM-DD.xlsx \
  00A1D6
```

Color `00A1D6` = Bilibili blue header.

---

## FETCH_PAGE_FN (JavaScript for evaluate)

```javascript
// Replace KEYWORD, PAGE, ORDER before calling
(async () => {
  const kw = encodeURIComponent("KEYWORD");
  const page = PAGE;
  const order = "ORDER"; // pubdate | totalrank | click | dm | stow
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${kw}&order=${order}&page=${page}&page_size=42`;
  const r = await fetch(url, { credentials: "include" });
  const d = await r.json();
  if (d.code !== 0) return JSON.stringify({ error: d.message });
  const items = (d.data?.result || []).map((v, i) => ({
    rank: i + 1,
    title: (v.title || "").replace(/<[^>]+>/g, ""),
    author: v.author || "",
    views: v.play || 0,
    danmaku: v.video_review || v.danmaku || 0,
    duration: v.duration || "",
    pubdate: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : "",
    url: `https://www.bilibili.com/video/${v.bvid}`,
  }));
  return JSON.stringify(items);
})();
```

---

## API Reference

**Endpoint:**

```
https://api.bilibili.com/x/web-interface/search/type
  ?search_type=video
  &keyword=<encoded>
  &order=pubdate
  &page=1
  &page_size=42
```

| Parameter   | Options     | Description                    |
| ----------- | ----------- | ------------------------------ |
| `order`     | `pubdate`   | 最新发布 (newest first)        |
| `order`     | `totalrank` | 综合排序 (default)             |
| `order`     | `click`     | 最多播放                       |
| `order`     | `dm`        | 最多弹幕                       |
| `order`     | `stow`      | 最多收藏                       |
| `page_size` | 42          | Bilibili default, max per page |

## Output fields

| Field    | Description                             |
| -------- | --------------------------------------- |
| title    | Video title (HTML tags stripped)        |
| author   | Uploader name                           |
| views    | Play count                              |
| danmaku  | Bullet comment count                    |
| duration | Video length (e.g. "12:34")             |
| pubdate  | Publish date (YYYY-MM-DD)               |
| url      | `https://www.bilibili.com/video/{bvid}` |
| page     | Search result page number               |
| rank     | Position on that page                   |

## Notes

- The tab must be on bilibili.com domain so `fetch()` uses the right cookies.
- No login required for search — public results work without auth.
- The old raw WebSocket CDP approach (`/tmp/node_modules/ws`) is deprecated in favour of the built-in browser tool.
- `bili_scrape.js` is kept as a standalone CLI fallback for use outside the agent.
