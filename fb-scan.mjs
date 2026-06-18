#!/usr/bin/env node
/**
 * fb-scan.mjs — 獨立的 FB 社團爬取 + 規則篩選工具(與 scan.mjs 無關)
 *
 * 用 Playwright + 常駐瀏覽器 profile(.fb-profile/)保存 FB 登入,
 * 讀 config/fb-targets.yml 的 target 與條件,爬貼文、套規則篩選,
 * 把新符合的物件寫進 config 指定的 output_file(預設 data/fb-finds.md)。
 *
 * 一次性登入:
 *   node fb-scan.mjs --login        # 開瀏覽器,你手動登入 FB,登好按 Enter
 *
 * 日常掃描:
 *   node fb-scan.mjs                # 開瀏覽器(看得到),確認登入後按 Enter 開爬
 *   node fb-scan.mjs --yes          # 不問,確認登入就直接爬(排程用)
 *   node fb-scan.mjs --headless     # 無頭模式(排程用,需 profile 已登入)
 *   node fb-scan.mjs --dry-run      # 爬+篩但不寫檔,結果印在終端機
 *
 * 純 Node + Playwright + js-yaml(都已是 repo 依賴)。不呼叫任何 LLM、不需 API key。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';
import readline from 'readline';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, '.fb-profile');
const CONFIG_PATH = path.join(ROOT, 'config', 'fb-targets.yml');

const args = process.argv.slice(2);
const FLAGS = {
  login: args.includes('--login'),
  yes: args.includes('--yes'),
  headless: args.includes('--headless'),
  dryRun: args.includes('--dry-run'),
};

// ── small helpers ────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`找不到設定檔:${CONFIG_PATH}`);
    process.exit(1);
  }
  const cfg = yaml.load(readFileSync(CONFIG_PATH, 'utf-8')) || {};
  cfg.groups = Array.isArray(cfg.groups) ? cfg.groups.filter((g) => g && g.enabled !== false) : [];
  cfg.searches = Array.isArray(cfg.searches) ? cfg.searches : [];
  cfg.output_dir = expandHome(cfg.output_dir || 'data/rent');
  cfg.dedup_file = cfg.dedup_file || 'data/fb-seen.tsv';
  return cfg;
}

// 展開開頭的 ~ 成家目錄,並轉成絕對路徑
function expandHome(p) {
  let out = String(p);
  if (out === '~' || out.startsWith('~/')) out = path.join(os.homedir(), out.slice(1));
  return path.isAbsolute(out) ? out : path.join(ROOT, out);
}

// ── rent parsing ─────────────────────────────────────────────────────
// 從貼文文字抓出所有看起來像「月租」的金額(處理逗號、「萬」、元/月、NT$ 等)。
export function parseRents(text) {
  if (!text) return [];
  const t = String(text).replace(/，/g, ',').replace(/：/g, ':');
  const found = new Set();
  const push = (n) => { if (Number.isFinite(n) && n >= 3000 && n <= 300000) found.add(n); };

  // x.x萬 / x萬
  for (const m of t.matchAll(/([\d.]+)\s*萬/g)) push(Math.round(parseFloat(m[1]) * 10000));
  // 租金/月租 後面接數字
  for (const m of t.matchAll(/(?:租金|月租|房租)[^\d]{0,8}(\d[\d,]{2,})/g)) push(parseInt(m[1].replace(/,/g, ''), 10));
  // 數字 + 元/月 或 /月
  for (const m of t.matchAll(/(\d[\d,]{2,})\s*(?:元|NTD)?\s*\/?\s*月/g)) push(parseInt(m[1].replace(/,/g, ''), 10));
  // NT$ / $ 前綴
  for (const m of t.matchAll(/(?:NT\$|＄|\$)\s*(\d[\d,]{2,})/g)) push(parseInt(m[1].replace(/,/g, ''), 10));

  return [...found].sort((a, b) => a - b);
}

// ── 房間數語意比對 ───────────────────────────────────────────────────
// 中文數字轉阿拉伯(只處理房型常見的 1~9 + 兩),讓「一大房一廳」「2房1廳」都能比。
const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function normNums(s) {
  return String(s).replace(/[一二兩三四五六七八九]/g, (c) => CN_NUM[c]);
}
// 抓出文字中所有「N房」的房間數(N 緊鄰「房」,排除套房/雅房這種前面非數字的)
function bedroomCounts(text) {
  const set = new Set();
  for (const m of normNums(text).matchAll(/(\d)\s*大?\s*房/g)) set.add(Number(m[1]));
  return set;
}
// 一個 layout 關鍵字若含「房…廳」→ 用房間數比對;否則用字面(套房/雅房/整層)
function matchLayout(text, kw) {
  const core = kw.replace(/[（(].*$/, '').trim();
  if (/房[\s\S]*廳/.test(core)) {
    const want = bedroomCounts(core);
    const have = bedroomCounts(text);
    for (const n of want) if (have.has(n)) return core;
    return null;
  }
  return text.includes(core) ? core : null;
}

// ── rule matcher ─────────────────────────────────────────────────────
const FEMALE_ONLY = /限女|僅限女|只租女|女性限定|女生限定|限女性|女生公寓|女性宿|女生宿/;
const FEMALE_ROOMMATES = /室友[^。\n]{0,25}(都是|皆|全為|全是)女|姊妹|姐妹/;
const NOT_FEMALE_ONLY = /不限男女|不限性別|男女[皆都]可/;

// 回傳針對「一組條件」的判定:{ verdict: 'match'|'uncertain'|'reject', reasons, notes }
export function evaluateSearch(post, search) {
  const text = post.text || '';
  const inc = search.include || {};
  const exc = search.exclude || {};
  const reasons = [];
  const notes = [];

  // 1) 排除條件 → 直接 reject(keywords 與 locations 都檢查)
  for (const kw of exc.keywords || []) {
    if (text.includes(kw)) return { verdict: 'reject', reasons: [`排除關鍵字:${kw}`], notes };
  }
  for (const loc of exc.locations || []) {
    if (text.includes(loc)) return { verdict: 'reject', reasons: [`排除地點:${loc}`], notes };
  }

  // 2) 租金
  const rents = parseRents(text);
  const min = inc.rent_min ?? 0;
  const max = inc.rent_max ?? Infinity;
  let rentOk = null; // null = 抓不到租金
  if (rents.length) {
    const hit = rents.find((r) => r >= min && r <= max);
    rentOk = !!hit;
    if (hit) notes.push(`租金 ${hit.toLocaleString()}`);
    else reasons.push(`租金不在 ${min || 0}~${max === Infinity ? '∞' : max}(抓到 ${rents.map((r) => r.toLocaleString()).join('/')})`);
  } else {
    notes.push('租金未明');
  }
  if (rentOk === false) return { verdict: 'reject', reasons, notes };

  // 3) 格局關鍵字(核心,缺則 reject)
  const layouts = inc.layout || [];
  let coreLayout = null;
  if (layouts.length) {
    for (const kw of layouts) {
      const hit = matchLayout(text, kw);
      if (hit) { coreLayout = hit; break; }
    }
    if (!coreLayout) return { verdict: 'reject', reasons: [...reasons, `格局不符(要 ${layouts.join('/')})`], notes };
    notes.push(`格局:${coreLayout}`);
  }

  // 3b) 雅房特例:雅房需室友皆女生,否則 uncertain
  let femaleUncertain = false;
  if (coreLayout === '雅房') {
    if (FEMALE_ONLY.test(text) || FEMALE_ROOMMATES.test(text)) notes.push('室友女生/限女 ✓');
    else femaleUncertain = true;
  }

  // 4) must_have(缺則 uncertain,不直接 reject — 貼文常省略)
  let mustMissing = false;
  for (const need of inc.must_have || []) {
    if (text.includes(need)) notes.push(`${need} ✓`);
    else { mustMissing = true; notes.push(`${need}?(未提及)`); }
  }

  // 5) preference / 女生限定(軟條件,加註)
  if (FEMALE_ONLY.test(text)) notes.push('⭐限女生');
  else if (NOT_FEMALE_ONLY.test(text) && (search.include?.preference || []).length) notes.push('註:不限男女');

  // 6) optional(軟條件,只報告)
  for (const opt of search.optional || []) {
    if (text.includes(opt)) notes.push(`+${opt}`);
  }

  if (rentOk === null || mustMissing || femaleUncertain) {
    return { verdict: 'uncertain', reasons, notes };
  }
  return { verdict: 'match', reasons, notes };
}

// 把一篇貼文跑過所有條件,回傳最佳結果
function classifyPost(post, searches) {
  let best = null;
  for (const s of searches) {
    const r = evaluateSearch(post, s);
    const rank = { match: 3, uncertain: 2, reject: 1 }[r.verdict];
    if (!best || rank > best.rank) best = { ...r, rank, search: s.name };
    if (r.verdict === 'match') break;
  }
  return best;
}

// ── dedup ────────────────────────────────────────────────────────────
function postKey(post) {
  return (post.text || '').replace(/\s+/g, '').slice(0, 60);
}
function loadSeen(file) {
  const seen = new Set();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const k = line.split('\t')[0];
      if (k) seen.add(k);
    }
  }
  return seen;
}
function appendSeen(file, keys, date) {
  if (!keys.length) return;
  if (!existsSync(file)) writeFileSync(file, 'key\tfirst_seen\n', 'utf-8');
  appendFileSync(file, keys.map((k) => `${k}\t${date}`).join('\n') + '\n', 'utf-8');
}

// ── scraping (跑在頁面內,邏輯與手動驗證版一致) ──────────────────────
async function scrapeGroup(page, group) {
  const scrolls = Number(group.scroll) || 12;
  return await page.evaluate(async (scrolls) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const harvested = new Map();
    const clean = (raw) => raw.split('\n').map((s) => s.trim())
      .filter((s) => s.length > 1 && s !== 'Facebook' && s !== '追蹤' && s !== '·').join('\n');

    const harvest = () => {
      const feed = document.querySelector('div[role="feed"]');
      if (!feed) return;
      for (const u of feed.children) {
        const raw = u.innerText || '';
        if (raw.length < 80) continue;
        const text = clean(raw);
        const body = text.replace(/^[\s\S]*?(?=區域|格局|租金|地址|位置|地點|捷運|NT\$|#|套房|雅房|整層|房東|出租|頂加|電梯|月租)/, '');
        const key = (body || text).replace(/\s+/g, '').slice(0, 60);
        if (!key || harvested.has(key)) continue;
        const listing = u.querySelector('a[href*="/commerce/listing/"]');
        const a = u.querySelector('a[href*="/commerce/listing/"], a[href*="/groups/"][href*="__cft__"]');
        harvested.set(key, {
          permalink: a ? a.href.split('&__tn__')[0].slice(0, 130) : null,
          listing: listing ? (listing.innerText || '').replace(/\s+/g, ' ').trim() : null,
          text: (body || text).slice(0, 1200),
        });
      }
    };
    const expandMore = () => {
      const btns = Array.from(document.querySelectorAll('div[role="button"], span'))
        .filter((el) => { const t = el.textContent.trim(); return t === '查看更多' || t === 'See more'; });
      for (const b of btns) { try { b.click(); } catch (e) {} }
    };

    for (let i = 0; i < scrolls; i++) {
      expandMore();
      await sleep(700);
      harvest();
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1600);
    }
    expandMore(); await sleep(700); harvest();
    return [...harvested.values()];
  }, scrolls);
}

// ── output ───────────────────────────────────────────────────────────
function renderEntry(post, cls) {
  const head = cls.verdict === 'match' ? '✅' : '〽️';
  const tag = cls.verdict === 'match' ? cls.search : `${cls.search}(待確認)`;
  const lines = [`### ${head} [${tag}]`];
  if (cls.notes.length) lines.push(`- ${cls.notes.join(' · ')}`);
  const firstLine = (post.text || '').split('\n').find((s) => s.trim()) || '';
  lines.push(`- ${firstLine.slice(0, 80)}`);
  if (post.permalink) lines.push(`- 發文者:${post.permalink}`);
  return lines.join('\n');
}

// scan 檔用:每篇貼文都列,標出判定結果(含被拒原因)
function renderScanEntry(post, cls) {
  const icon = { match: '✅', uncertain: '〽️', reject: '⛔' }[cls.verdict];
  const tail = cls.verdict === 'reject'
    ? (cls.reasons.join(' · ') || '不符')
    : (cls.notes.join(' · ') || cls.search);
  const firstLine = (post.text || '').split('\n').find((s) => s.trim()) || '';
  const lines = [`### ${icon} ${cls.search} — ${firstLine.slice(0, 60)}`, `- ${tail}`];
  if (post.permalink) lines.push(`- ${post.permalink}`);
  return lines.join('\n');
}

// 寫日期檔:不存在 → 建檔(含標題);已存在(同日重跑)→ 追加一段時間戳區塊
function writeDated(filePath, title, blocks) {
  const time = new Date().toTimeString().slice(0, 5);
  if (existsSync(filePath)) {
    appendFileSync(filePath, `\n---\n## ⏱ ${time} 重跑新增\n\n${blocks.join('\n\n')}\n`, 'utf-8');
  } else {
    writeFileSync(filePath, `${title}\n\n${blocks.join('\n\n')}\n`, 'utf-8');
  }
}

async function isLoggedIn(page) {
  // 登入牆會出現密碼欄位
  const pw = await page.$('input[name="pass"], input[type="password"]');
  return !pw;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const cfg = loadConfig();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: FLAGS.headless && !FLAGS.login,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW',
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    // 一次性登入模式
    if (FLAGS.login) {
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      console.log('\n👉 請在開啟的瀏覽器視窗手動登入 FB(含 2FA)。');
      await prompt('登入完成、看得到首頁後,回來按 Enter 結束…');
      console.log('✅ 登入狀態已存進 .fb-profile/,之後 node fb-scan.mjs 就會沿用。');
      return;
    }

    if (cfg.groups.length === 0) { console.error('fb-targets.yml 沒有啟用的 groups。'); return; }
    if (cfg.searches.length === 0) { console.error('fb-targets.yml 沒有 searches 條件。'); return; }

    const date = new Date().toISOString().slice(0, 10);
    const seen = loadSeen(path.join(ROOT, cfg.dedup_file));
    const newKeys = [];
    const findBlocks = []; // 命中(符合+待確認)
    const scanBlocks = []; // 全部新貼文(原始+判定)
    let totalScraped = 0, totalNew = 0, totalMatch = 0, totalUncertain = 0;
    let confirmed = false; // 只在第一個社團確認一次

    for (const group of cfg.groups) {
      console.log(`\n📍 ${group.name} — ${group.url}`);
      await page.goto(group.url, { waitUntil: 'domcontentloaded' });
      await sleep(2500);

      if (!(await isLoggedIn(page))) {
        console.error('⚠️  未登入 FB。請先執行:node fb-scan.mjs --login');
        return;
      }

      // 只在第一個社團確認一次登入(--yes 完全跳過)
      if (!FLAGS.yes && !confirmed) {
        await prompt('登入 OK?確認頁面已載入社團貼文後,按 Enter 開始爬(之後的社團不再詢問)…');
        confirmed = true;
      }

      console.log(`   滾動抓取中(scroll=${group.scroll || 12})…`);
      const posts = await scrapeGroup(page, group);
      totalScraped += posts.length;

      const groupFinds = [];
      const groupScans = [];
      let groupNew = 0;
      for (const post of posts) {
        const key = postKey(post);
        if (seen.has(key) || newKeys.includes(key)) continue; // 去重
        newKeys.push(key);
        totalNew++; groupNew++;
        const cls = classifyPost(post, cfg.searches);
        if (cls.verdict === 'match') totalMatch++;
        else if (cls.verdict === 'uncertain') totalUncertain++;
        groupScans.push(renderScanEntry(post, cls));
        if (cls.verdict === 'match' || cls.verdict === 'uncertain') {
          groupFinds.push(renderEntry(post, cls));
        }
      }

      if (groupFinds.length) findBlocks.push(`## ${group.name}\n\n${groupFinds.join('\n\n')}`);
      if (groupScans.length) scanBlocks.push(`## ${group.name}\n\n${groupScans.join('\n\n')}`);
      console.log(`   抓到 ${posts.length} 篇,去重後新增 ${groupNew},符合+待確認 ${groupFinds.length}`);
    }

    console.log(`\n${'━'.repeat(40)}`);
    console.log(`掃描完成 ${date}`);
    console.log(`  總抓取:${totalScraped} 篇`);
    console.log(`  去重後新貼文:${totalNew} 篇`);
    console.log(`  ✅ 符合:${totalMatch} · 〽️ 待確認:${totalUncertain}`);

    if (FLAGS.dryRun) {
      console.log('\n(--dry-run,不寫檔)\n');
      if (findBlocks.length) console.log(findBlocks.join('\n\n'));
      else console.log('(無命中物件)');
      return;
    }

    // 寫兩個日期檔到 output_dir:scan-<date>.md(全部)、find-<date>.md(命中)
    mkdirSync(cfg.output_dir, { recursive: true });
    if (scanBlocks.length) {
      writeDated(path.join(cfg.output_dir, `scan-${date}.md`), `# 掃描全紀錄 ${date}`, scanBlocks);
      console.log(`\n→ 全紀錄:${path.join(cfg.output_dir, `scan-${date}.md`)}`);
    }
    if (findBlocks.length) {
      writeDated(path.join(cfg.output_dir, `find-${date}.md`), `# 篩選命中 ${date}`, findBlocks);
      console.log(`→ 命中清單:${path.join(cfg.output_dir, `find-${date}.md`)}`);
    } else {
      console.log('\n沒有新的符合物件。');
    }
    appendSeen(path.join(ROOT, cfg.dedup_file), newKeys, date);
  } finally {
    await context.close();
  }
}

// 只在直接執行時跑 main(),被 import 時(測試)只暴露純函式
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
