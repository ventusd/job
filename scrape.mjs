// Boss直聘 + 脉脉（免Cookie）：用 Playwright 真浏览器渲染页面
// - Boss：优先拦截 /wapi/zpgeek/search/joblist.json 响应（JSON最稳），失败再读DOM
// - 脉脉：读渲染后的DOM
// - 支持多关键词、多城市、多页；输出 ./public/jobs.json

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const QUERIES = ["音频","音效","音频策划","声音设计","Audio","Sound"];
const CITIES = [
  { name: "上海", code: "101020100" },
  { name: "杭州", code: "101210100" }
];
const PAGES = 3;                 // 每个关键词/城市抓前N页（Boss/脉脉各自处理）
const MIN_WAIT = 800, MAX_WAIT = 1800;

const OUT_DIR = path.join(process.cwd(), "public");
const OUT_FILE = path.join(OUT_DIR, "jobs.json");

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const rand = (a,b)=> a + Math.floor(Math.random()*(b-a+1));

async function newContext() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "KHTML, like Gecko Chrome/123 Safari/537.36",
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  // 节流：拦截图片/字体/媒体
  await page.route("**/*", (route) => {
    const r = route.request();
    const type = r.resourceType();
    if (["image","media","font","stylesheet"].includes(type)) return route.abort();
    route.continue();
  });

  return { browser, context, page };
}

/* ---------------- Boss直聘 ---------------- */
async function scrapeBossOnce(query, city, pageIndex, page) {
  const url = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(query)}&city=${city.code}&page=${pageIndex}`;
  const results = [];

  // 等待抓取 JSON 响应
  const jsonPromise = page.waitForResponse(
    (res) => res.url().includes("/wapi/zpgeek/search/joblist.json") && res.status() === 200,
    { timeout: 15000 }
  ).catch(()=>null);

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await sleep(rand(MIN_WAIT, MAX_WAIT));

  // 1) 尝试 JSON
  const jsonRes = await jsonPromise;
  if (jsonRes) {
    try {
      const data = await jsonRes.json();
      const list = (data.zpData && data.zpData.jobList) || data.data?.jobList || [];
      for (const j of list) {
        const title = j.jobName || "";
        const company = j.brandName || "";
        const cityName = j.cityName || city.name;
        const id = j.encryptJobId || j.encryptJobIdStr || j.jobId || "";
        const href = id ? `https://www.zhipin.com/job_detail/${id}.html` : url;
        if (title && href) {
          results.push({ source: "Boss直聘", title, company, city: cityName, url: href, query });
        }
      }
      if (results.length) return results;
    } catch (e) {
      // JSON变化就继续走DOM
    }
  }

  // 2) DOM 回退（职位卡）
  const cards = await page.$$('[class*="job-card-wrapper"], [class*="job-card-body"]');
  for (const card of cards) {
    const t = await card.$('.job-name, .title, [class*="job-name-wrap"]');
    const a = await card.$('a[href*="/job_detail/"]');
    if (!t || !a) continue;
    const title = (await t.textContent()||"").trim();
    const href = await a.getAttribute("href");
    const cEl = await card.$('.company-name, .company-info');
    const company = cEl ? (await cEl.textContent()||"").trim() : "";
    if (title && href) {
      results.push({
        source: "Boss直聘",
        title,
        company,
        city: city.name,
        url: href.startsWith("http") ? href : `https://www.zhipin.com${href}`,
        query
      });
    }
  }
  return results;
}

async function scrapeBossAll() {
  const { browser, page } = await newContext();
  const out = [];
  try {
    for (const city of CITIES) {
      for (const q of QUERIES) {
        for (let p=1; p<=PAGES; p++) {
          try {
            const items = await scrapeBossOnce(q, city, p, page);
            out.push(...items);
            await sleep(rand(MIN_WAIT, MAX_WAIT));
          } catch (e) {
            console.log(`[Boss] ${q}@${city.name}#${p} error:`, (e && e.message)||e);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`[Boss] total ${out.length}`);
  return out;
}

/* ---------------- 脉脉 ---------------- */
async function scrapeMaimaiOnce(query, city, pageIndex, page) {
  // 脉脉分页通常用 page 参数；若无就抓前几屏
  const url = `https://maimai.cn/job/search?city=${encodeURIComponent(city.name)}&q=${encodeURIComponent(query)}&page=${pageIndex}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await sleep(rand(MIN_WAIT, MAX_WAIT));

  const links = await page.$$('a[href*="/job/detail/"]');
  const items = [];
  for (const a of links) {
    const href = await a.getAttribute("href");
    const text = (await a.textContent()||"").trim();
    if (!href || !text) continue;
    items.push({
      source: "脉脉",
      title: text,
      company: "",
      city: city.name,
      url: href.startsWith("http") ? href : `https://maimai.cn${href}`,
      query
    });
  }
  return items;
}

async function scrapeMaimaiAll() {
  const { browser, page } = await newContext();
  const out = [];
  try {
    for (const city of CITIES) {
      for (const q of QUERIES) {
        for (let p=1; p<=PAGES; p++) {
          try {
            const items = await scrapeMaimaiOnce(q, city, p, page);
            out.push(...items);
            await sleep(rand(MIN_WAIT, MAX_WAIT));
          } catch (e) {
            console.log(`[脉脉] ${q}@${city.name}#${p} error:`, (e && e.message)||e);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`[脉脉] total ${out.length}`);
  return out;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const [boss, mm] = await Promise.all([
    scrapeBossAll(),
    scrapeMaimaiAll()
  ]);

  // 合并去重
  const seen = new Set();
  const all = [...boss, ...mm].filter(it=>{
    const k = `${it.source}|${it.title}|${it.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const payload = { ts: Date.now(), items: all };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Saved ${all.length} -> ${OUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
