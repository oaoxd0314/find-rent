#!/usr/bin/env node
// fb-scan.mjs — FB 社團爬取 + 規則篩選。
// 資料流:scan(Playwright 抓貼文)→ scan-DATE.jsonl(SSOT)→ filter(套 config)→ find-DATE.md。
// flags: --login --yes --headless --dry-run --refilter [date] --renew --count N --concurrency N
// 行為契約看 fb-scan.test.js(那才是 spec)。

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import os from 'os';
import path from 'path';
import readline from 'readline';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, '.fb-profile');
const CONFIG_PATH = path.join(ROOT, 'config', 'fb-targets.yml');

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}
const FLAGS = {
  count: flagValue('--count'),
  concurrency: flagValue('--concurrency'),
  login: args.includes('--login'),
  yes: args.includes('--yes'),
  headless: args.includes('--headless'),
  dryRun: args.includes('--dry-run'),
  refilter: args.includes('--refilter'),
  refilterDate: flagValue('--refilter'),
  renew: args.includes('--renew'),
};

// ── helpers ──────────────────────────────────────────────────────────
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
    .map((g) => ({ scroll: 12, ...g }));
  cfg.searches = Array.isArray(cfg.searches) ? cfg.searches : [];
  cfg.output_dir = expandHome(cfg.output_dir || 'data/rent');
  cfg.dedup_file = cfg.dedup_file || 'data/fb-seen.tsv';
  return cfg;
}

function expandHome(p) {
  let out = String(p);
  if (out === '~' || out.startsWith('~/')) out = path.join(os.homedir(), out.slice(1));
  return path.isAbsolute(out) ? out : path.join(ROOT, out);
}

// ── rent parsing ─────────────────────────────────────────────────────
function toHalfWidth(s) {
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

export function parseRents(text) {
  if (!text) return [];
  const t = toHalfWidth(text)
    .replace(/，/g, ',').replace(/：/g, ':')
    .replace(/[—–－~～〜]/g, '-');
  const labeled = new Set();
  const generic = new Set();
  const valid = (n) => Number.isFinite(n) && n >= 3000 && n <= 300000;
  const num = (s) => parseInt(String(s).replace(/,/g, ''), 10);
  // 租補後的金額不算月租(列原價),純 #租金補貼 hashtag 沒帶數字不會誤抓
  const subsidized = new Set();
  for (const m of t.matchAll(/(?:租金補貼後|租補後|補貼後|補助後|補後|租補)\s*[(（]?\s*(?:NT\$|NTD|\$|元)?\s*(\d[\d,]{2,})/g)) {
    subsidized.add(num(m[1]));
  }
  const add = (set, n) => { if (valid(n) && !subsidized.has(n)) set.add(n); };

  for (const m of t.matchAll(/(?:租金|月租|房租)[^\d]{0,8}(\d[\d,]{2,})(?:\s*-\s*(\d[\d,]{2,}))?/g)) {
    add(labeled, num(m[1]));
    if (m[2]) add(labeled, num(m[2]));
  }
  for (const m of t.matchAll(/(\d[\d,]{2,})(?:\s*-\s*(\d[\d,]{2,}))?\s*(?:元|NTD)?\s*\/?\s*月/g)) {
    add(labeled, num(m[1]));
    if (m[2]) add(labeled, num(m[2]));
  }
  for (const m of t.matchAll(/([\d.]+)\s*(?:-\s*([\d.]+)\s*)?萬/g)) {
    add(generic, Math.round(parseFloat(m[1]) * 10000));
    if (m[2]) add(generic, Math.round(parseFloat(m[2]) * 10000));
  }
  for (const m of t.matchAll(/(?:NT\$|\$)\s*(\d[\d,]{2,})/g)) add(generic, num(m[1]));

  const pick = labeled.size ? labeled : generic;
  return [...pick].sort((a, b) => a - b);
}

// ── 房間數語意比對 ───────────────────────────────────────────────────
const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function normNums(s) {
  return toHalfWidth(s).replace(/[一二兩三四五六七八九]/g, (c) => CN_NUM[c]);
}
function bedroomCounts(text) {
  const set = new Set();
  for (const m of normNums(text).matchAll(/(\d)\s*大?\s*房/g)) set.add(Number(m[1]));
  return set;
}
// 有格局欄位時只比那段,避免「共1套房4雅房」這種整棟描述把雅房當套房。
const LAYOUT_FIELD = /(?:【\s*格局\s*】|格局\s*[:：])([^\n]*)/;
export function layoutScope(text) {
  const m = String(text || '').match(LAYOUT_FIELD);
  return m ? m[1] : null;
}
// 含「房…廳」→ 比房間數;否則比字面(套房/雅房/整層)
function matchLayout(text, kw, haveBedrooms) {
  const core = kw.replace(/[（(].*$/, '').trim();
  if (/房[\s\S]*廳/.test(core)) {
    const want = bedroomCounts(core);
    const have = haveBedrooms ? new Set(haveBedrooms) : bedroomCounts(text);
    for (const n of want) if (have.has(n)) return core;
    return null;
  }
  return (layoutScope(text) ?? text).includes(core) ? core : null;
}

// ── 地點精準比對 ─────────────────────────────────────────────────────
// 只在「地名情境」才命中(後綴 信義區/新店路、或前綴 在新店/#信義),避開「木新店」這種黏詞。
// 有地址欄位/hashtag 時只比那段,避免「可直達內湖」這種交通/地標敘述被當成物件所在地。
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACE_SUFFIX = '區|路|街|段|巷|弄|里|村|站|捷運|夜市|商圈|生活圈|公園';
const PLACE_PREFIX = '地址|地點|位置|區域|社區|位於|鄰近|靠近|近|在|到|往|住|＃|#';
const ADDR_FIELD = /(?:【\s*(?:地址|位置|地點|區域)\s*】|(?:地址|位置|地點|區域)\s*[:：])([^\n]*)/g;
const HASHTAG = /[#＃][^\s#＃]+/g;
export function locationScope(full) {
  const t = String(full || '');
  const parts = [];
  for (const m of t.matchAll(ADDR_FIELD)) parts.push(m[1]);
  for (const m of t.matchAll(HASHTAG)) parts.push(m[0]);
  return parts.length ? parts.join('\n') : null;
}
export function matchLocation(full, loc) {
  if (!loc) return false;
  const hay = locationScope(full) ?? String(full || '');
  const L = escapeRe(loc);
  return new RegExp(`${L}(?:${PLACE_SUFFIX})`).test(hay)
    || new RegExp(`(?:^|[\\s,，。、:：;；/／()（）「」【】〔〕\\[\\]\\-—~〜·]|${PLACE_PREFIX})${L}`, 'm').test(hay);
}

// ── 買賣 / 求租文偵測(供 meta;偵測到不直接丟,要丟靠 config exclude)──
const SALE_KEYWORDS = /出售|售屋|自售|屋主自售|賞屋|總價|開價|委託價|權狀|實價登錄|買賣|售價|誠售|降價求售|物件編號/;
export function looksLikeSale(text) {
  const t = String(text || '').replace(/，/g, ',');
  if (SALE_KEYWORDS.test(t)) return true;
  for (const m of t.matchAll(/([\d.,]+)\s*萬/g)) {
    if (parseFloat(m[1].replace(/,/g, '')) >= 100) return true; // ≥100 萬 → 買賣總價
  }
  return false;
}
const WANTED_KEYWORDS =
  /求租|徵租|尋租|代租|急租(?!金)|找房|求屋|徵屋|預算|求[\s\S]{0,6}(?:套房|雅房|整層|分租|合租|公寓|住處|大?房)|(?:徵|想找|想租|找尋|誠徵|急徵|尋找|代尋)[\s\S]{0,8}(?:套房|雅房|整層|分租|合租|租屋|房子|住處)/;
export function looksLikeWanted(text) {
  return WANTED_KEYWORDS.test(String(text || '').replace(/，/g, ','));
}

// ── 性別訊號 ─────────────────────────────────────────────────────────
// 每個「男」都加 (?!女) 排除「男女不拘」這種開放語意。
const FEMALE_ONLY = /限女|僅限女|只租女|女性限定|女生限定|限女性|女生公寓|女性宿|女生宿/;
const FEMALE_ROOMMATES = /室友[^。\n]{0,25}(都是|皆|全為|全是)女|姊妹|姐妹/;
const NOT_FEMALE_ONLY = /不限男女|不限性別|男女[皆都]可/;
const MALE_ONLY = /限男(?!女)|僅限男|只租男|只收男|男性限定|男生限定|限男性/;
const MALE_ROOMMATE =
  /男(?:室友|房客|住戶)|室友[^。\n]{0,25}(?:都是|皆|全為|全是)男(?!女)|(?:room|房間?|[A-Za-z]室)\s*[A-Za-z0-9]?[\s:：.\-、]{0,3}[^。\n]{0,10}男(?!女)|男(?:生|性|業務|上班族|工程師|學生)(?!女)/i;
const ANTI_MALE = /不要男|不收男|不租男|勿男|非男|謝絕男|男(?:生|性|士)?勿|限女|僅限女|只租女|徵女|女性限定|女生限定/;

// 從貼文抽「與 config 無關」的結構化欄位,存進 scan jsonl。
// config 相關的字串比對(地點/關鍵字/optional)留在篩選當下算,否則改 config 就得重爬。
export function extractMeta(post) {
  const text = post.text || '';
  const full = post.rawText || post.text || '';
  return {
    rents: parseRents(text),
    bedrooms: [...bedroomCounts(text)],
    isSale: looksLikeSale(full),
    isWanted: looksLikeWanted(full),
    femaleOnly: FEMALE_ONLY.test(text),
    femaleRoommates: FEMALE_ROOMMATES.test(text),
    notFemaleOnly: NOT_FEMALE_ONLY.test(text),
    maleSignal: (MALE_ONLY.test(text) || MALE_ROOMMATE.test(text)) && !ANTI_MALE.test(text),
  };
}

// ── 條件評分 ─────────────────────────────────────────────────────────
// 欄位:layout/locations/keywords 任一即命中;must_have 須全部出現。rent 在 evaluateSearch 另算。
function evalFields(block, meta, text, full) {
  const out = [];
  if (block.layout?.length) {
    let core = null;
    for (const kw of block.layout) { const h = matchLayout(text, kw, meta.bedrooms); if (h) { core = h; break; } }
    out.push({ key: 'layout', hit: !!core, which: core,
      note: core ? `格局:${core}` : `格局?不符(要 ${block.layout.join('/')})` });
  }
  if (block.locations?.length) {
    const which = block.locations.find((loc) => matchLocation(full, loc));
    out.push({ key: 'locations', hit: !!which, which,
      note: which ? `地點:${which}` : `地點?不在範圍(要 ${block.locations.join('/')})` });
  }
  if (block.keywords?.length) {
    const which = block.keywords.find((kw) => full.includes(kw));
    out.push({ key: 'keywords', hit: !!which, which, note: which ? `關鍵字:${which}` : null });
  }
  if (block.must_have?.length) {
    const missing = block.must_have.filter((n) => !full.includes(n));
    out.push({ key: 'must_have', hit: missing.length === 0, which: null,
      note: missing.length ? `${missing.join('/')}?(未提及)` : `${block.must_have.join('/')} ✓` });
  }
  return out;
}

// 落在 [min,max] → 'in';整段超出 → 'out';沒抓到 → 'unknown';沒設租金 → 'none'。out/unknown 不丟,只是不加分。
function rentGate(inc, meta) {
  if (inc.rent_min == null && inc.rent_max == null) return { state: 'none', note: null };
  const min = inc.rent_min ?? 0, max = inc.rent_max ?? Infinity;
  const rents = meta.rents || [];
  if (!rents.length) return { state: 'unknown', note: '租金未明' };
  const hit = rents.find((r) => r >= min && r <= max);
  const range = `${min || 0}~${max === Infinity ? '∞' : max}`;
  if (hit) return { state: 'in', note: `租金 ${hit.toLocaleString()}` };
  return { state: 'out', note: `租金 ${rents.map((r) => r.toLocaleString()).join('/')}(超出 ${range})` };
}

// GATE:只有 exclude 命中 → reject。SCORE:include 每欄 +2(含租金落在區間)、optional 每欄 +1。
// TIER:include 全中 → match;否則 score≥1 → uncertain;score=0 → drop。maleSignal → 改標 gender。
export function evaluateSearch(post, search) {
  const text = post.text || '';
  const full = post.rawText || post.text || '';
  const meta = extractMeta(post);
  const inc = search.include || {};
  const exc = search.exclude || {};
  const opt = Array.isArray(search.optional) ? { keywords: search.optional } : (search.optional || {});
  const notes = [];
  const rej = (reason) => ({ verdict: 'reject', score: 0, reasons: [reason], notes });

  for (const f of evalFields(exc, meta, text, full)) {
    if (!f.hit) continue;
    const reason = f.key === 'locations' ? `排除地點:${f.which}`
      : f.key === 'layout' ? `排除格局:${f.which}`
      : f.key === 'must_have' ? `排除設備:${f.which}` : `排除關鍵字:${f.which}`;
    return rej(reason);
  }

  let genderFlag = false, femalePlus = false;
  if (opt.roommate_female === true || exc.roommate_male === true) {
    if (meta.maleSignal) { genderFlag = true; notes.push('🚻 偵測到男性訊號'); }
    else if (meta.femaleOnly || meta.femaleRoommates) { femalePlus = true; notes.push('⭐ 室友女生友善'); }
  }

  let includeHits = 0, includeTotal = 0, optionalHits = 0;
  if (inc.rent_min != null || inc.rent_max != null) {
    includeTotal++;
    const rent = rentGate(inc, meta);
    if (rent.note) notes.push(rent.note);
    if (rent.state === 'in') includeHits++;
  }
  for (const f of evalFields(inc, meta, text, full)) {
    includeTotal++;
    notes.push(f.note);
    if (f.hit) includeHits++;
  }
  for (const f of evalFields(opt, meta, text, full)) {
    if (f.hit) { optionalHits++; notes.push(`+${f.note}`); }
  }
  if (femalePlus) optionalHits++;

  const includeOk = includeHits === includeTotal;
  const score = includeHits * 2 + optionalHits;

  let verdict;
  if (includeOk) verdict = 'match';
  else if (score >= 1) verdict = 'uncertain';
  else return rej('零命中');
  if (genderFlag) verdict = 'gender';

  return { verdict, score, reasons: [], notes };
}

const VERDICT_RANK = { match: 4, gender: 3, uncertain: 2, reject: 1 };

// 一篇貼文跑過所有條件,取最佳(層級優先,同層比 score)。
export function classifyPost(post, searches) {
  let best = null;
  for (const s of searches) {
    const r = evaluateSearch(post, s);
    const rank = VERDICT_RANK[r.verdict];
    const better = !best || rank > best.rank || (rank === best.rank && (r.score || 0) > (best.score || 0));
    if (better) best = { ...r, rank, search: s.name };
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

// ── scraping ─────────────────────────────────────────────────────────
// 整段 body 跑在 page.evaluate 內(瀏覽器 context),不能 import,helpers 須在內重宣告。
async function scrapeGroup(page, scrolls) {
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
        const postA = u.querySelector(
          'a[href*="/groups/"][href*="/posts/"], a[href*="/groups/"][href*="/permalink/"], a[href*="/commerce/listing/"]'
        );
        const authorA = u.querySelector('a[href*="/groups/"][href*="/user/"]');
        const cleanUrl = (el) => (el ? el.href.split('?')[0].split('&')[0] : null);
        harvested.set(key, {
          permalink: cleanUrl(postA),
          author: cleanUrl(authorA),
          listing: listing ? (listing.innerText || '').replace(/\s+/g, ' ').trim() : null,
          text: (body || text).slice(0, 1200),
          rawText: text.slice(0, 2000),
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
// 預覽行:挑第一個像樣的描述(跳過純 hashtag 與太短碎片),都沒有才退回第一個非空行。
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
  else if (post.author) lines.push(`- 發文者:${post.author}`);
  return lines.join('\n');
}

// ── scan 資料層 (jsonl) / 篩選 ────────────────────────────────────────
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

const FIND_TIERS = ['match', 'uncertain', 'gender'];
const TIER_TITLE = { match: '## ✅ 符合', uncertain: '## 〽️ 待確認', gender: '## 🚻 性別待確認' };

function runFilter(records, searches) {
  const tiers = { match: [], uncertain: [], gender: [] };
  for (const rec of records) {
    const cls = classifyPost(rec, searches);
    if (!tiers[cls.verdict]) continue;
    tiers[cls.verdict].push({ group: rec.group || '(未分類)', score: cls.score || 0, md: renderEntry(rec, cls) });
  }
  return { tiers, match: tiers.match.length, uncertain: tiers.uncertain.length, gender: tiers.gender.length };
}
// 依層級分區(✅→〽️→🚻),區內按 score 高到低排(同分再按社團)。
function writeFind(file, date, result) {
  const out = [
    `# 篩選命中 ${date}`,
    '',
    `✅ 符合 ${result.match} · 〽️ 待確認 ${result.uncertain} · 🚻 性別待確認 ${result.gender}`,
  ];
  for (const tier of FIND_TIERS) {
    const entries = result.tiers[tier];
    if (!entries.length) continue;
    entries.sort((a, b) => b.score - a.score || a.group.localeCompare(b.group, 'zh-Hant'));
    out.push('', TIER_TITLE[tier], '', entries.map((e) => e.md).join('\n\n'));
  }
  writeFileSync(file, out.join('\n') + '\n', 'utf-8');
}

async function isLoggedIn(page) {
  const pw = await page.$('input[name="pass"], input[type="password"]');
  return !pw;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const cfg = loadConfig();

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
    const newKeys = FLAGS.dryRun ? [] : readScanRecords(scanPath).map((r) => postKey(r));
    const allRecords = [];
    const stats = { totalScraped: 0 };

    if (!FLAGS.dryRun) mkdirSync(cfg.output_dir, { recursive: true });

    // 第一次 ctrl+c → 跑完目前社團、寫檔後才停;第二次 → 強制結束
    let stopRequested = false;
    process.on('SIGINT', () => {
      if (stopRequested) { console.log('\n強制中止。'); process.exit(130); }
      stopRequested = true;
      console.log('\n⏹  收到中斷,跑完目前社團、寫檔後就停(再按一次 ctrl+c 強制結束)…');
    });

    // 把一個社團爬到的貼文吃進去:去重 → 暫存 → 落檔。
    // 全程同步(無 await),所以多個 worker 平行呼叫也不會交錯/競態。
    const ingest = (group, posts) => {
      stats.totalScraped += posts.length;
      const groupRecords = [];
      const groupKeys = [];
      for (const post of posts) {
        const key = postKey(post);
        if (newKeys.includes(key)) continue;
        if (!FLAGS.renew && seen.has(key)) continue;
        newKeys.push(key); groupKeys.push(key);
        groupRecords.push({ ...post, group: group.name, meta: extractMeta(post) });
      }
      allRecords.push(...groupRecords);
      console.log(`   [${group.name}] 抓到 ${posts.length} 篇,去重後新增 ${groupKeys.length}`);
      if (!FLAGS.dryRun) {
        appendScanRecords(scanPath, groupRecords);
        appendSeen(seenFile, groupKeys, date);
      }
    };

    // 單一 page 依序爬完指定社團(序列 = 整份 groups;平行 = 該 worker 分到的那批)。
    const scrapeGroups = async (groups, p) => {
      for (const group of groups) {
        if (stopRequested) break;
        console.log(`\n📍 ${group.name} — ${group.url}`);
        await p.goto(group.url, { waitUntil: 'domcontentloaded' });
        await sleep(2500);
        if (!(await isLoggedIn(p))) {
          console.error(`⚠️  未登入 FB(${group.name})。請先執行:node fb-scan.mjs --login`);
          stopRequested = true;
          break;
        }
        const scrolls = Number(FLAGS.count || group.scroll);
        console.log(`   滾動抓取中(scroll=${scrolls})…`);
        ingest(group, await scrapeGroup(p, scrolls));
      }
    };

    const concurrency = Math.max(1, Number(FLAGS.concurrency) || 1);
    if (concurrency === 1) {
      // 序列:沿用主 persistent context,保留首次互動確認(--yes 跳過)。
      await page.goto(cfg.groups[0].url, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      if (!(await isLoggedIn(page))) {
        console.error('⚠️  未登入 FB。請先執行:node fb-scan.mjs --login');
        return;
      }
      if (!FLAGS.yes) {
        await prompt('登入 OK?確認頁面已載入社團貼文後,按 Enter 開始爬…');
      }
      await scrapeGroups(cfg.groups, page);
    } else {
      // 平行:用主 context 確認登入並抽 storageState,再開 N 個獨立瀏覽器分批爬。
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      if (!(await isLoggedIn(page))) {
        console.error('⚠️  未登入 FB。請先執行:node fb-scan.mjs --login');
        return;
      }
      const storageState = await context.storageState();
      const buckets = Array.from({ length: concurrency }, () => []);
      cfg.groups.forEach((g, i) => buckets[i % concurrency].push(g));
      const active = buckets.filter((b) => b.length);
      console.log(`\n🧵 平行模式:${active.length} 個瀏覽器,各分到 ${active.map((b) => b.length).join('/')} 個社團`);
      await Promise.all(active.map(async (bucket) => {
        const browser = await chromium.launch({ headless: FLAGS.headless });
        try {
          const wctx = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
          await scrapeGroups(bucket, await wctx.newPage());
        } finally {
          await browser.close();
        }
      }));
    }

    const result = runFilter(allRecords, cfg.searches);
    console.log(`\n${'━'.repeat(40)}`);
    console.log(`掃描完成 ${date}`);
    console.log(`  總抓取:${stats.totalScraped} 篇`);
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

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
