# find-rent

爬 FB 租屋社團、依 `config/fb-targets.yml` 的條件篩選,每天輸出 Markdown 命中清單。純 Playwright + 規則比對,不呼叫 LLM、不需 API key。

## 安裝

```bash
pnpm install
cp config/fb-targets.yml.sample config/fb-targets.yml   # 填社團與條件
pnpm fb-login                                           # 開瀏覽器登入 FB,登好按 Enter
```

登入用 `pnpm fb-login`(不是 `pnpm login`,那是登 npm)。session 過期時 log 會顯示「未登入」,重跑 `pnpm fb-login` 即可。

## 指令

```bash
pnpm scan                        # 爬所有社團 → 篩選 → 寫進 output/
pnpm dry                         # 同上但不寫檔,結果印在終端機
node fb-scan.mjs --refilter      # 不爬,只用當天既有資料重跑篩選
```

`pnpm scan` 後面接的參數會原樣傳給 `fb-scan.mjs`。常用 flag(可疊加):

- `--refilter [日期]` — 只重跑篩選,不開瀏覽器。**改完 config 用這個**:讀當天 `scan-*.jsonl` 重生 `find`。省略日期 = 今天,例:`--refilter 2026-06-21`。
- `--renew` — 跳過跨次去重,把看過的貼文也重新拉出來(`fb-seen` 照樣維護,只是不拿它擋結果)。
- `--count N` — 覆寫滾動次數(抓越多越慢),不給就用各社團自己的 `scroll`。
- `--yes` — 不問登入確認,直接爬(排程用)。
- `--headless` — 無頭模式,不開可見視窗(排程用,需已登入過)。
- `--login` — 開瀏覽器手動登入並存 session(= `pnpm fb-login`)。
- `--dry-run` — 爬 + 篩但不寫檔(= `pnpm dry`)。

捷徑:`pnpm scan:log` = `--yes` + 同步寫 `fb-scan.log`(跑完即走、之後 `tail` 看);此 script 吃不了額外參數。

## 運作方式

```
scan(爬 + 抽 meta) ──▶ scan-YYYY-MM-DD.jsonl   資料層
                  └──▶ filter(套 config) ──▶ find-YYYY-MM-DD.md
```

- 篩選與爬取分離:改條件只要 `--refilter`,不必重爬。
- 去重記在 `data/fb-seen.tsv`,看過的不重列;清空重評全部:`rm data/fb-seen.tsv`。

## 權重判定與設定

編輯 `config/fb-targets.yml`:

- `groups:` — 社團清單。`enabled: false` 暫停某個;`scroll:` 控制抓取量。
- `searches:` — 一或多組條件,每篇貼文比對所有組、取最佳結果。

判定 = **GATE(門檻)+ SCORE(評分排序)**(借鑑 career-ops):先用保守門檻丟掉明確不合的,其餘評分排序、不丟。

- **GATE**(命中就排除):`exclude` 任一欄位、買賣/求租文、租金整段超出範圍。
- **SCORE**:每命中一欄 → include 計 2 分、optional 計 1 分。
- **分層**:`include` 全中 → `符合`;否則 score≥1 → `待確認`(按分排序);零命中 → 不顯示。

三個 block 共用欄位(`layout`/`locations`/`keywords`/`must_have`;`rent_min`/`rent_max` 只放 include):

- `include:` — 全中才算 `符合`;每命中一欄加分。
- `optional:` — 不影響 `符合`,命中只加分(把零命中救成 `待確認`、並往前排)。
- `exclude:` — 任一命中就排除。另 `roommate_female: true` →偵測到男 → `性別待確認`、女生友善 → 加分。

欄位語意:`layout`/`locations`/`keywords` 出現任一即命中;`must_have` 須全部出現;`rent` 落在區間(沒寫租金 → 放行)。範例:

```yaml
searches:
  - name: "整層住家"
    include:                 # 全中 → 符合
      rent_min: 10000
      rent_max: 33000
      layout: ["兩房一廳"]
      locations: ["信義", "大安"]
    optional:                # 加分:沒全中也能進待確認、命中越多排越前
      layout: ["一房一廳"]
      keywords: ["陽台", "洗衣機"]
    exclude:                 # 任一命中就丟掉
      keywords: ["頂加", "出售文"]
      locations: ["三重"]
```

## 定時自動跑(launchd,選用)

```bash
cp com.chriswang.fb-scan.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chriswang.fb-scan.plist
launchctl start com.chriswang.fb-scan    # 立即測一次
tail -20 fb-scan.log
```

預設每天 09:00 / 21:00 以 `--yes --headless` 跑。改時間編 plist 的 `Hour`/`Minute`,再 `launchctl unload && launchctl load`;移除則 `launchctl unload` 後刪檔。

- 無頭跑**不能重新登入**:session 過期需手動 `pnpm fb-login`。
- 睡眠中錯過的排程喚醒後補跑一次;關機則跳過。
