#!/usr/bin/env node
/**
 * jd_scrape.js — Scrape JD.com search results to JSON
 *
 * NOTE: The preferred approach is for the agent to use the built-in `browser`
 * tool (profile: vnc-chrome) directly — see SKILL.md for the agent workflow.
 *
 * This script is a standalone CLI fallback that connects to Chrome's CDP
 * directly when running outside the agent context.
 *
 * Usage: node jd_scrape.js <keyword> <pages> <output.json>
 *
 * Requires:
 *   - Chrome running with --remote-debugging-port=9222 (Playclaw profile)
 *   - ws module: cd /tmp && npm install ws
 */
const WebSocket = require("/tmp/node_modules/ws");
const http = require("http");
const fs = require("fs");

const keyword = process.argv[2] || "佳明运动手表";
const pages = parseInt(process.argv[3] || "2");
const outFile = process.argv[4] || "/tmp/jd_results.json";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getTab() {
  return new Promise((resolve, reject) => {
    http
      .get("http://localhost:9222/json", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          const tabs = JSON.parse(d);
          resolve(tabs.find((t) => t.type === "page"));
        });
      })
      .on("error", reject);
  });
}

function cdpEval(wsUrl, fn, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => {
      ws.close();
      reject("timeout");
    }, 25000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: fn, awaitPromise, returnByValue: true },
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

function cdpNavigate(wsUrl, url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => {
      ws.close();
      reject("nav timeout");
    }, 25000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Page.enable" })));
    let done = false;
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id === 1) ws.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url } }));
      if (m.method === "Page.loadEventFired" && !done) {
        done = true;
        clearTimeout(t);
        ws.close();
        resolve();
      }
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e.message);
    });
  });
}

const SCROLL_FN = `(async()=>{
  for(let i=0;i<18;i++){window.scrollBy(0,500);await new Promise(r=>setTimeout(r,300))}
  window.scrollTo(0,document.body.scrollHeight)
  await new Promise(r=>setTimeout(r,1500))
  window.scrollTo(0,0)
  return document.querySelectorAll('[class*="goodsCardWrapper"]').length+''
})()`;

const EXTRACT_FN = `(()=>{
  const items=[]
  document.querySelectorAll('[class*="goodsCardWrapper"]').forEach(card=>{
    try{
      const titleEl=card.querySelector('[class*="goods_title_container"] span[title]')
      const title=(titleEl?.getAttribute('title')||titleEl?.textContent||'').trim()
      if(!title)return
      const pc=card.querySelector('[class*="container_d0rf6"],[class*="priceConter"]')
      const pe=pc?.querySelector('[class*="price_d0rf6"],[class*="price_t0dwj"]')
      let price=''
      if(pe){
        const y=pe.querySelector('[class*="yen"]')?.textContent||''
        const m=pe.childNodes[1]?.textContent||''
        const d=pe.querySelector('[class*="decimal"]')?.textContent||''
        price=y+m+(d?'.'+d:'')
      }
      const oe=pc?.querySelector('[class*="gray"],[class*="origin"],del,s')
      const origPrice=(oe?.textContent||'').replace(/[^0-9.]/g,'').trim()
      const feats=[]
      card.querySelectorAll('[class*="text-list"] span,[class*="common-wrap"] span[title]').forEach(s=>{
        const t=s.textContent.replace(/[|"]/g,'').trim()
        if(t&&t.length<30&&!t.includes('榜')&&!t.includes('补贴'))feats.push(t)
      })
      const sold=(card.querySelector('[class*="goods_volume"]')?.textContent||'').trim()
      const store=(card.querySelector('[class*="shopFloor"]')?.textContent||'').trim()
      let url=''
      const cl=card.querySelector('a[href*="chat.jd.com"]')
      if(cl){const pid=cl.href.match(/pid=(\\d+)/)?.[1];if(pid)url='https://item.jd.com/'+pid+'.html'}
      items.push({title,price,origPrice,features:feats.join(', '),sold,store,url})
    }catch(e){}
  })
  return JSON.stringify(items)
})()`;

function makeClickPage(p) {
  return `(()=>{
    const pagi=document.querySelector('[class*="pagiContainer"]')
    if(!pagi)return 'no pagi'
    for(const btn of pagi.querySelectorAll('[class*="pagination_item"]')){
      if(btn.textContent.trim()==='${p}'&&!btn.className.includes('active')){btn.click();return 'clicked ${p}'}
    }
    return 'not found'
  })()`;
}

(async () => {
  const kw = encodeURIComponent(keyword);
  const tab = await getTab();
  if (!tab) throw new Error("No Chrome tab found on port 9222");
  console.error(`Tab: ${tab.id}`);
  console.error(`Navigating to JD search: ${keyword}`);
  await cdpNavigate(
    tab.webSocketDebuggerUrl,
    `https://search.jd.com/Search?keyword=${kw}&enc=utf-8`,
  );
  await sleep(3000);

  const all = [];

  for (let p = 1; p <= pages; p++) {
    const t = await getTab();
    if (p > 1) {
      console.error(`Clicking page ${p}...`);
      const r = await cdpEval(t.webSocketDebuggerUrl, makeClickPage(p));
      console.error(`Pagination: ${r}`);
      await sleep(5000);
    }
    const t2 = await getTab();
    console.error(`Scrolling page ${p}...`);
    const count = await cdpEval(t2.webSocketDebuggerUrl, SCROLL_FN, true);
    console.error(`${count} cards visible`);
    const raw = await cdpEval(t2.webSocketDebuggerUrl, EXTRACT_FN);
    const items = JSON.parse(raw || "[]");
    console.error(`Page ${p}: ${items.length} extracted`);
    items.forEach((item, i) => all.push({ ...item, page: p, rank: i + 1 }));
    if (p < pages) await sleep(1000);
  }

  const seen = new Set();
  const deduped = all.filter((i) => {
    const k = i.url + "|" + i.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  fs.writeFileSync(outFile, JSON.stringify(deduped, null, 2));
  console.error(`Done: ${deduped.length} unique items → ${outFile}`);
  console.log(JSON.stringify(deduped));
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
