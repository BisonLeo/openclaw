#!/usr/bin/env node
/**
 * bili_scrape.js — Fetch Bilibili search results via API through browser cookies
 *
 * NOTE: The preferred approach is for the agent to use the built-in `browser`
 * tool (profile: vnc-chrome) directly — see SKILL.md for the agent workflow.
 *
 * This script is a standalone CLI fallback that connects to Chrome's CDP
 * directly when running outside the agent context.
 *
 * Usage: node bili_scrape.js <keyword> <pages> <output.json>
 *
 * Requires:
 *   - Chrome with bilibili.com open + --remote-debugging-port=9222
 *   - ws module: cd /tmp && npm install ws
 */
const WebSocket = require("/tmp/node_modules/ws");
const http = require("http");
const fs = require("fs");

const keyword = process.argv[2] || "佳明运动手表";
const pages = parseInt(process.argv[3] || "2");
const outFile = process.argv[4] || "/tmp/bili_results.json";
const ORDER = process.env.BILI_ORDER || "pubdate"; // pubdate | totalrank | click | dm | stow

function getTab() {
  return new Promise((resolve, reject) => {
    http
      .get("http://localhost:9222/json", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          const tabs = JSON.parse(d);
          // Prefer bilibili tab for cookie context, fall back to any page tab
          resolve(
            tabs.find((t) => t.type === "page" && t.url.includes("bilibili")) ||
              tabs.find((t) => t.type === "page"),
          );
        });
      })
      .on("error", reject);
  });
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => {
      ws.close();
      reject("timeout");
    }, 20000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      ),
    );
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id === 1) {
        clearTimeout(t);
        ws.close();
        if (m.result?.exceptionDetails) reject(m.result.exceptionDetails.text);
        else resolve(m.result?.result?.value);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e.message);
    });
  });
}

function makeFetchFn(kw, page, order) {
  return `(async()=>{
    const url='https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${kw}&order=${order}&page=${page}&page_size=42'
    const r=await fetch(url,{credentials:'include'})
    const d=await r.json()
    if(d.code!==0)return JSON.stringify({error:d.message})
    return JSON.stringify((d.data?.result||[]).map((v,i)=>({
      rank:i+1,
      title:(v.title||'').replace(/<[^>]+>/g,''),
      author:v.author||'',
      views:v.play||0,
      danmaku:v.video_review||v.danmaku||0,
      duration:v.duration||'',
      pubdate:v.pubdate?new Date(v.pubdate*1000).toISOString().slice(0,10):'',
      url:'https://www.bilibili.com/video/'+v.bvid
    })))
  })()`;
}

(async () => {
  const kw = encodeURIComponent(keyword);
  const tab = await getTab();
  if (!tab) throw new Error("No Chrome tab found on port 9222");
  console.error(`Using tab: ${tab.url.slice(0, 60)}`);

  const all = [];
  for (let p = 1; p <= pages; p++) {
    console.error(`Fetching page ${p} (order=${ORDER})...`);
    const raw = await cdpEval(tab.webSocketDebuggerUrl, makeFetchFn(kw, p, ORDER));
    const items = JSON.parse(raw || "[]");
    if (items.error) throw new Error(`Bilibili API error: ${items.error}`);
    console.error(`Page ${p}: ${items.length} items`);
    items.forEach((item) => all.push({ ...item, page: p }));
  }

  fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.error(`Done: ${all.length} items → ${outFile}`);
  console.log(JSON.stringify(all));
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
