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
 *   node fb-scan.mjs --renew        # 跳過跨次去重(fb-seen 不擋),強制重新拿到結果
 *   node fb-scan.mjs --refilter     # 不開瀏覽器,只用今天的 scan jsonl 重跑篩選
 *   node fb-scan.mjs --refilter 2026-06-21   # 指定日期重跑篩選
 *
 * 資料流:scan(動瀏覽器,抓 + 抽 meta)→ scan-YYYY-MM-DD.jsonl(SSOT,機器用)
 *         → filter(套 config 判斷)→ find-YYYY-MM-DD.md(人眼看的命中清單)。
 * 改了 config 不必重爬,--refilter 直接從 jsonl 重生 find。
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
// --count N:覆寫滾動次數(沒給就用各 group 自己的 scroll)
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}
const FLAGS = {
  count: flagValue('--count'),
  login: args.includes('--login'),
  yes: args.includes('--yes'),
  headless: args.includes('--headless'),
  dryRun: args.includes('--dry-run'),
  refilter: args.includes('--refilter'),  // 只重跑篩選(讀現有 scan jsonl),不開瀏覽器
  refilterDate: flagValue('--refilter'),  // --refilter 2026-06-21,沒給就用今天
  renew: args.includes('--renew'),        // 跳過跨次去重,強制重新拿到結果(當天 jsonl 重寫)
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
  cfg.groups = (Array.isArray(cfg.groups) ? cfg.groups.filter((g) => g && g.enabled !== false) : [])
    .map((g) => ({ scroll: 12, ...g })); // scroll 預設 12,可在 config 各 group 覆寫
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
// 全形 → 半形(數字、$、,、:、-… 一次轉掉),貼文常混全形數字「１５０００」。
function toHalfWidth(s) {
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

// 從貼文文字抓出所有看起來像「月租」的金額(處理全形、逗號、「萬」、元/月、NT$、區間 X-Y 等)。
// 策略:有「明確標租金」的金額時只用那些(避開預算/押金/坪數等雜訊);否則才退而用一般疑似金額。
export function parseRents(text) {
  if (!text) return [];
  const t = toHalfWidth(text)
    .replace(/，/g, ',').replace(/：/g, ':')
    .replace(/[—–－~～〜]/g, '-'); // 各式破折號/波浪號 → 區間用的 -
  const labeled = new Set(); // 明確標「租金/月租/房租/元月」的金額(可信)
  const generic = new Set(); // 其他疑似金額(萬、$ 前綴…)
  const valid = (n) => Number.isFinite(n) && n >= 3000 && n <= 300000;
  const num = (s) => parseInt(String(s).replace(/,/g, ''), 10);
  const add = (set, n) => { if (valid(n)) set.add(n); };

  // 標籤型:租金/月租/房租 後接金額,可為區間 X-Y(兩端都收)
  for (const m of t.matchAll(/(?:租金|月租|房租)[^\d]{0,8}(\d[\d,]{2,})(?:\s*-\s*(\d[\d,]{2,}))?/g)) {
    add(labeled, num(m[1]));
    if (m[2]) add(labeled, num(m[2]));
  }
  // 標籤型:數字 + 元/月 或 /月,可為區間
  for (const m of t.matchAll(/(\d[\d,]{2,})(?:\s*-\s*(\d[\d,]{2,}))?\s*(?:元|NTD)?\s*\/?\s*月/g)) {
    add(labeled, num(m[1]));
    if (m[2]) add(labeled, num(m[2]));
  }
  // 一般型:x.x萬 / x萬,可為區間(1.5萬-1.8萬 / 1.5-1.8萬)
  for (const m of t.matchAll(/([\d.]+)\s*(?:-\s*([\d.]+)\s*)?萬/g)) {
    add(generic, Math.round(parseFloat(m[1]) * 10000));
    if (m[2]) add(generic, Math.round(parseFloat(m[2]) * 10000));
  }
  // 一般型:NT$ / $ 前綴
  for (const m of t.matchAll(/(?:NT\$|\$)\s*(\d[\d,]{2,})/g)) add(generic, num(m[1]));

  const pick = labeled.size ? labeled : generic;
  return [...pick].sort((a, b) => a - b);
}

// ── 房間數語意比對 ───────────────────────────────────────────────────
// 中文數字轉阿拉伯(只處理房型常見的 1~9 + 兩),讓「一大房一廳」「2房1廳」都能比。
const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function normNums(s) {
  return toHalfWidth(s).replace(/[一二兩三四五六七八九]/g, (c) => CN_NUM[c]);
}
// 抓出文字中所有「N房」的房間數(N 緊鄰「房」,排除套房/雅房這種前面非數字的)
function bedroomCounts(text) {
  const set = new Set();
  for (const m of normNums(text).matchAll(/(\d)\s*大?\s*房/g)) set.add(Number(m[1]));
  return set;
}
// 一個 layout 關鍵字若含「房…廳」→ 用房間數比對;否則用字面(套房/雅房/整層)
// haveBedrooms:文中房間數(scan 階段預存的 meta.bedrooms),沒給才臨場算。
function matchLayout(text, kw, haveBedrooms) {
  const core = kw.replace(/[（(].*$/, '').trim();
  if (/房[\s\S]*廳/.test(core)) {
    const want = bedroomCounts(core);
    const have = haveBedrooms ? new Set(haveBedrooms) : bedroomCounts(text);
    for (const n of want) if (have.has(n)) return core;
    return null;
  }
  return text.includes(core) ? core : null;
}

// ── 買賣文偵測 ───────────────────────────────────────────────────────
// 租屋社團常混入售屋/仲介貼文。用關鍵字 + 大額「萬」總價判斷(月租不會以「萬」為單位喊到 ≥100 萬)。
const SALE_KEYWORDS = /出售|售屋|自售|屋主自售|賞屋|總價|開價|委託價|權狀|實價登錄|買賣|售價|誠售|降價求售|物件編號/;
export function looksLikeSale(text) {
  const t = String(text || '').replace(/，/g, ',');
  if (SALE_KEYWORDS.test(t)) return true;
  for (const m of t.matchAll(/([\d.,]+)\s*萬/g)) {
    if (parseFloat(m[1].replace(/,/g, '')) >= 100) return true; // ≥100 萬 → 幾乎都是買賣總價
  }
  return false;
}

// ── 求租文偵測 ───────────────────────────────────────────────────────
// 「求租 / 徵租 / 求獨立套房 / 想找雅房…」這類找房文(非出租),逐字列關鍵字補不完,改用語意規則。
const WANTED_KEYWORDS =
  /求租|徵租|尋租|代租|急租(?!金)|找房|求屋|徵屋|預算|求[\s\S]{0,6}(?:套房|雅房|整層|分租|合租|公寓|住處|大?房)|(?:徵|想找|想租|找尋|誠徵|急徵|尋找|代尋)[\s\S]{0,8}(?:套房|雅房|整層|分租|合租|租屋|房子|住處)/;
export function looksLikeWanted(text) {
  return WANTED_KEYWORDS.test(String(text || '').replace(/，/g, ','));
}

// ── rule matcher ─────────────────────────────────────────────────────
const FEMALE_ONLY = /限女|僅限女|只租女|女性限定|女生限定|限女性|女生公寓|女性宿|女生宿/;
const FEMALE_ROOMMATES = /室友[^。\n]{0,25}(都是|皆|全為|全是)女|姊妹|姐妹/;
const NOT_FEMALE_ONLY = /不限男女|不限性別|男女[皆都]可/;
// 男性訊號(積極版):限男、男室友、分房清單裡的男性住戶(男生/男性/男業務…)。
// 每個「男」都加 (?!女) 排除「男女不拘/不限男女/適合男女」這種開放語意(那些是 男女 連寫)。
const MALE_ONLY = /限男(?!女)|僅限男|只租男|只收男|男性限定|男生限定|限男性/;
const MALE_ROOMMATE =
  /男(?:室友|房客|住戶)|室友[^。\n]{0,25}(?:都是|皆|全為|全是)男(?!女)|(?:room|房間?|[A-Za-z]室)\s*[A-Za-z0-9]?[\s:：.\-、]{0,3}[^。\n]{0,10}男(?!女)|男(?:生|性|業務|上班族|工程師|學生)(?!女)/i;
// 否定/女生優先:出現「不要男/不收男/謝絕男/徵女/限女」這類 → 其實是女生友善,maleSignal 抑制掉
const ANTI_MALE = /不要男|不收男|不租男|勿男|非男|謝絕男|男(?:生|性|士)?勿|限女|僅限女|只租女|徵女|女性限定|女生限定/;

// 從一篇貼文抽出「與條件無關」的結構化欄位,存進 scan jsonl(資料層)。
// 與 config 有關的字串比對(地點/關鍵字/must_have/optional)不在這裡 ——
// 那些必須在篩選當下對「當時的 config」算,否則改 config 就得重爬。
export function extractMeta(post) {
  const text = post.text || '';
  // 排除/買賣文判斷一律用未裁切的全文(body 會切掉開頭的「出售文」等標題)
  const full = post.rawText || post.text || '';
  return {
    rents: parseRents(text),
    bedrooms: [...bedroomCounts(text)], // 文中所有「N房」的房間數
    isSale: looksLikeSale(full),
    isWanted: looksLikeWanted(full),
    femaleOnly: FEMALE_ONLY.test(text),
    femaleRoommates: FEMALE_ROOMMATES.test(text),
    notFemaleOnly: NOT_FEMALE_ONLY.test(text),
    // 限男 / 男室友 / 分房清單有男;但出現否定或女生友善訊號(不要男/徵女/限女…)則抑制
    maleSignal: (MALE_ONLY.test(text) || MALE_ROOMMATE.test(text)) && !ANTI_MALE.test(text),
  };
}

// 回傳針對「一組條件」的判定:{ verdict: 'match'|'uncertain'|'reject', reasons, notes }
// 判定哲學:
//   - 命中 exclude(關鍵字/地點)或買賣/求租文 → reject(唯一會被踢掉的情況)
//   - include 條件(地點/租金/格局/must_have)全符合 → match
//   - 沒命中 exclude,但 include 有缺 → uncertain(待確認,留給人工看)
// 也就是 include 全是「軟條件」:不滿足只降級待確認,不再直接 reject。
// meta 一律用當前 code 從 text 重新推導(不信 jsonl 裡的快取)——
// 這樣調整偵測邏輯後 --refilter 會立刻反映,不必重爬;jsonl 的 meta 只供人工檢視。
export function evaluateSearch(post, search) {
  const text = post.text || '';
  const full = post.rawText || post.text || '';
  const meta = extractMeta(post);
  const inc = search.include || {};
  const exc = search.exclude || {};
  const reasons = [];
  const notes = [];
  let uncertain = false; // 任一 include 條件沒滿足就降級待確認
  let genderFlag = false; // 偵測到男性訊號(roommate_male)→ 獨立的 gender 層級,不靜默丟掉

  // 0) 買賣文 / 求租文 → 直接 reject(租屋社團常混入售屋、仲介、找房文)
  if (meta.isSale) return { verdict: 'reject', reasons: ['買賣文(非租屋)'], notes };
  if (meta.isWanted) return { verdict: 'reject', reasons: ['求租文(非出租)'], notes };

  // 1) 排除條件 → 直接 reject(keywords 與 locations 都檢查)—— 唯一的硬性踢除
  for (const kw of exc.keywords || []) {
    if (full.includes(kw)) return { verdict: 'reject', reasons: [`排除關鍵字:${kw}`], notes };
  }
  for (const loc of exc.locations || []) {
    if (full.includes(loc)) return { verdict: 'reject', reasons: [`排除地點:${loc}`], notes };
  }
  // 室友性別:exclude.roommate_male=true(女生友善)時,偵測到男性訊號 → 標 gender(待性別確認)
  // 不直接 reject,避免積極偵測的誤判被靜默丟掉;其餘 include 條件照常算,notes 一起帶出來。
  if (exc.roommate_male && meta.maleSignal) {
    genderFlag = true;
    notes.push('🚻 偵測到男性訊號');
  }

  // 1b) 指定地點:沒命中 → 待確認(不 reject)
  const incLocs = inc.locations || [];
  if (incLocs.length) {
    const hitLoc = incLocs.find((loc) => full.includes(loc));
    if (hitLoc) notes.push(`地點:${hitLoc}`);
    else { uncertain = true; notes.push(`地點?不在範圍(要 ${incLocs.join('/')})`); }
  }

  // 2) 租金:超出範圍或抓不到 → 待確認(不 reject)
  const rents = meta.rents || [];
  const min = inc.rent_min ?? 0;
  const max = inc.rent_max ?? Infinity;
  if (rents.length) {
    const hit = rents.find((r) => r >= min && r <= max);
    if (hit) notes.push(`租金 ${hit.toLocaleString()}`);
    else { uncertain = true; notes.push(`租金?不在 ${min || 0}~${max === Infinity ? '∞' : max}(抓到 ${rents.map((r) => r.toLocaleString()).join('/')})`); }
  } else {
    uncertain = true; notes.push('租金未明');
  }

  // 3) 格局:沒命中 → 待確認(不 reject)
  const layouts = inc.layout || [];
  let coreLayout = null;
  if (layouts.length) {
    for (const kw of layouts) {
      const hit = matchLayout(text, kw, meta.bedrooms);
      if (hit) { coreLayout = hit; break; }
    }
    if (coreLayout) notes.push(`格局:${coreLayout}`);
    else { uncertain = true; notes.push(`格局?不符(要 ${layouts.join('/')})`); }
  }

  // 室友皆女:純裝飾性標註,不影響判定(女生友善的硬性踢除已在 exclude.roommate_male 處理)
  if (meta.femaleRoommates) notes.push('室友皆女 ✓');

  // 4) must_have(缺則 uncertain — 貼文常省略)
  for (const need of inc.must_have || []) {
    if (text.includes(need)) notes.push(`${need} ✓`);
    else { uncertain = true; notes.push(`${need}?(未提及)`); }
  }

  // 5) preference / 女生限定(軟條件,加註)
  if (meta.femaleOnly) notes.push('⭐限女生');
  else if (meta.notFemaleOnly && (inc.preference || []).length) notes.push('註:不限男女');

  // 6) optional(軟條件,只報告)
  for (const opt of search.optional || []) {
    if (text.includes(opt)) notes.push(`+${opt}`);
  }

  if (genderFlag) return { verdict: 'gender', reasons, notes };
  return { verdict: uncertain ? 'uncertain' : 'match', reasons, notes };
}

// classifyPost 取最佳判定的排序:match > gender > uncertain > reject。
// gender 高於 uncertain,否則男訊號貼文會被其他條件的 uncertain 蓋掉、浮不上 🚻 區。
const VERDICT_RANK = { match: 4, gender: 3, uncertain: 2, reject: 1 };

// 把一篇貼文跑過所有條件,回傳最佳結果
function classifyPost(post, searches) {
  let best = null;
  for (const s of searches) {
    const r = evaluateSearch(post, s);
    const rank = VERDICT_RANK[r.verdict];
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
  const scrolls = Number(FLAGS.count || group.scroll);
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
        // 優先抓「貼文本身」的連結(/posts/、/permalink/、商品頁),而非發文者個人頁(/user/)
        const postA = u.querySelector(
          'a[href*="/groups/"][href*="/posts/"], a[href*="/groups/"][href*="/permalink/"], a[href*="/commerce/listing/"]'
        );
        const authorA = u.querySelector('a[href*="/groups/"][href*="/user/"]');
        // 去掉 query string,留乾淨可點的永久連結
        const cleanUrl = (el) => (el ? el.href.split('?')[0].split('&')[0] : null);
        harvested.set(key, {
          permalink: cleanUrl(postA),       // 貼文連結(抓不到時為 null)
          author: cleanUrl(authorA),        // 發文者個人頁(備用)
          listing: listing ? (listing.innerText || '').replace(/\s+/g, ' ').trim() : null,
          text: (body || text).slice(0, 1200),
          rawText: text.slice(0, 2000), // 未裁切的全文,供排除/買賣文判斷(body 會切掉開頭的「出售文」等標題)
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
// 預覽行:挑第一個「像樣的描述」——跳過純 hashtag(body 開頭常是 #標籤)與太短的碎片(如「出租】」),
// 都找不到才退回第一個非空行。
function previewLine(text) {
  const lines = (text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const good = lines.find((s) => !s.startsWith('#') && s.replace(/[#＃\s]/g, '').length >= 6);
  return good || lines[0] || '';
}

const VERDICT_ICON = { match: '✅', uncertain: '〽️', gender: '🚻', reject: '⛔' };
const VERDICT_SUFFIX = { match: '', uncertain: '(待確認)', gender: '(性別待確認)', reject: '(已排除)' };

function renderEntry(post, cls) {
  const head = VERDICT_ICON[cls.verdict] || '〽️';
  const groupTag = post.group ? ` · ${post.group}` : '';
  const lines = [`### ${head} [${cls.search}${VERDICT_SUFFIX[cls.verdict] || ''}]${groupTag}`];
  if (cls.notes.length) lines.push(`- ${cls.notes.join(' · ')}`);
  lines.push(`- ${previewLine(post.text).slice(0, 80)}`);
  if (post.permalink) lines.push(`- 貼文:${post.permalink}`);
  else if (post.author) lines.push(`- 發文者:${post.author}`); // 抓不到貼文連結才退回作者頁
  return lines.join('\n');
}

// ── scan 資料層 (jsonl) / 篩選 ────────────────────────────────────────
// scan-*.jsonl 是 SSOT(機器用):一篇貼文一行,含原始欄位 + 預存 meta + 社團名。
// find-*.md 是人眼版,由 runFilter 從 jsonl 套當下 config 重生 —— 改 config 只要 --refilter,不必重爬。
const scanJsonlPath = (dir, date) => path.join(dir, `scan-${date}.jsonl`);
const findMdPath = (dir, date) => path.join(dir, `find-${date}.md`);

function appendScanRecords(file, records) {
  if (!records.length) return;
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}
function readScanRecords(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* 跳過壞行 */ }
  }
  return out;
}

// find 收錄的層級(由好到差);reject 不入 find,留在 scan jsonl 資料層。
const FIND_TIERS = ['match', 'uncertain', 'gender'];
const TIER_TITLE = { match: '## ✅ 符合', uncertain: '## 〽️ 待確認', gender: '## 🚻 性別待確認' };

// 讀 scan 記錄 → 套 config 篩選 → 依判定層級分區的命中清單 + 統計。不碰瀏覽器。
function runFilter(records, searches) {
  const tiers = { match: [], uncertain: [], gender: [] };
  for (const rec of records) {
    const cls = classifyPost(rec, searches);
    if (!tiers[cls.verdict]) continue; // 只收 match/uncertain/gender
    tiers[cls.verdict].push({ group: rec.group || '(未分類)', md: renderEntry(rec, cls) });
  }
  return { tiers, match: tiers.match.length, uncertain: tiers.uncertain.length, gender: tiers.gender.length };
}
// find 檔:依層級分區(✅→〽️→🚻),每區內再按社團排序。
function writeFind(file, date, result) {
  const out = [
    `# 篩選命中 ${date}`,
    '',
    `✅ 符合 ${result.match} · 〽️ 待確認 ${result.uncertain} · 🚻 性別待確認 ${result.gender}`,
  ];
  for (const tier of FIND_TIERS) {
    const entries = result.tiers[tier];
    if (!entries.length) continue;
    entries.sort((a, b) => a.group.localeCompare(b.group, 'zh-Hant'));
    out.push('', TIER_TITLE[tier], '', entries.map((e) => e.md).join('\n\n'));
  }
  writeFileSync(file, out.join('\n') + '\n', 'utf-8');
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

  // ── refilter 模式:只讀現有 scan jsonl 重跑篩選,完全不開瀏覽器 ──
  if (FLAGS.refilter) {
    if (cfg.searches.length === 0) { console.error('fb-targets.yml 沒有 searches 條件。'); return; }
    const date = FLAGS.refilterDate || new Date().toISOString().slice(0, 10);
    const scanPath = scanJsonlPath(cfg.output_dir, date);
    const records = readScanRecords(scanPath);
    if (!records.length) {
      console.error(`找不到掃描資料:${scanPath}\n(先跑一次 node fb-scan.mjs 產生當天的 scan jsonl)`);
      return;
    }
    const result = runFilter(records, cfg.searches);
    const findPath = findMdPath(cfg.output_dir, date);
    writeFind(findPath, date, result);
    console.log(`重跑篩選 ${date}:讀 ${records.length} 篇 → ✅ 符合 ${result.match} · 〽️ 待確認 ${result.uncertain} · 🚻 性別待確認 ${result.gender}`);
    console.log(`→ 命中清單:${findPath}`);
    return;
  }

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
    const seenFile = path.join(ROOT, cfg.dedup_file);
    const seen = loadSeen(seenFile);
    const scanPath = scanJsonlPath(cfg.output_dir, date);
    const findPath = findMdPath(cfg.output_dir, date);
    // newKeys 同時擔任「當天 jsonl 已有的 key」——預載既有 jsonl,確保不論一般/renew 都不會寫重複行。
    const newKeys = FLAGS.dryRun ? [] : readScanRecords(scanPath).map((r) => postKey(r));
    const allRecords = []; // 本次新增的貼文(含 meta + group),交給 runFilter
    let totalScraped = 0;
    let confirmed = false; // 只在第一個社團確認一次

    if (!FLAGS.dryRun) mkdirSync(cfg.output_dir, { recursive: true });

    // 優雅中斷:第一次 ctrl+c → 跑完目前社團、寫檔後才停;第二次 → 強制結束
    let stopRequested = false;
    process.on('SIGINT', () => {
      if (stopRequested) { console.log('\n強制中止。'); process.exit(130); }
      stopRequested = true;
      console.log('\n⏹  收到中斷,跑完目前社團、寫檔後就停(再按一次 ctrl+c 強制結束)…');
    });

    for (const group of cfg.groups) {
      if (stopRequested) break;
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

      console.log(`   滾動抓取中(scroll=${FLAGS.count || group.scroll})…`);
      const posts = await scrapeGroup(page, group);
      totalScraped += posts.length;

      // scan 階段只負責「抓 + 抽 meta」,不做條件判斷 —— 判斷留給 runFilter。
      const groupRecords = [];
      const groupKeys = [];
      for (const post of posts) {
        const key = postKey(post);
        if (newKeys.includes(key)) continue;            // 已在當天 jsonl / 本次已處理 → 不重複寫
        if (!FLAGS.renew && seen.has(key)) continue;    // 跨次去重;--renew 時不擋,強制重拿(fb-seen 照樣記)
        newKeys.push(key); groupKeys.push(key);
        groupRecords.push({ ...post, group: group.name, meta: extractMeta(post) });
      }
      allRecords.push(...groupRecords);
      console.log(`   抓到 ${posts.length} 篇,去重後新增 ${groupKeys.length}`);

      // 逐社團即時寫 jsonl + 記去重,中途 ctrl+c 也保留已掃完的社團資料
      if (!FLAGS.dryRun) {
        appendScanRecords(scanPath, groupRecords);
        appendSeen(seenFile, groupKeys, date);
      }
    }

    // ── 篩選階段:從本次蒐集的記錄套 config → find-*.md ──
    const result = runFilter(allRecords, cfg.searches);
    console.log(`\n${'━'.repeat(40)}`);
    console.log(`掃描完成 ${date}`);
    console.log(`  總抓取:${totalScraped} 篇`);
    console.log(`  去重後新貼文:${allRecords.length} 篇`);
    console.log(`  ✅ 符合:${result.match} · 〽️ 待確認:${result.uncertain} · 🚻 性別待確認:${result.gender}`);

    if (FLAGS.dryRun) {
      console.log('\n(--dry-run,不寫檔)\n');
      const blocks = [];
      for (const tier of FIND_TIERS) {
        const entries = result.tiers[tier];
        if (entries.length) blocks.push(`${TIER_TITLE[tier]}\n\n${entries.map((e) => e.md).join('\n\n')}`);
      }
      console.log(blocks.length ? blocks.join('\n\n') : '(無命中物件)');
      return;
    }

    if (allRecords.length) console.log(`\n→ 掃描資料:${scanPath}`);
    if (result.match || result.uncertain || result.gender) {
      writeFind(findPath, date, result);
      console.log(`→ 命中清單:${findPath}`);
    } else {
      console.log('\n沒有新的符合物件。');
    }
  } finally {
    await context.close();
  }
}

// 只在直接執行時跑 main(),被 import 時(測試)只暴露純函式
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
