# find-rent

爬 FB 租屋社團、依 `config/fb-targets.yml` 的條件篩選,輸出 Markdown 命中清單到 `output/`。純 Playwright + 規則比對,不呼叫 LLM、不需 API key。

## 快速開始

```bash
pnpm install
cp config/fb-targets.yml.sample config/fb-targets.yml   # 填社團與條件
pnpm fb-login                                           # 開瀏覽器登入 FB,登好按 Enter
pnpm scan                                              # 開始爬 → 篩選 → 寫進 output/
```

> 登入用 `pnpm fb-login`(不是 npm 的 `login`)。session 過期時 log 會顯示「未登入」,重跑 `pnpm fb-login` 即可。

## 常用指令

```bash
pnpm scan                              # 爬所有社團 → 篩選 → 寫檔
node fb-scan.mjs --concurrency 3       # 平行開 3 個瀏覽器分批爬(快 ~3 倍)
node fb-scan.mjs --refilter            # 不爬,只用當天既有資料重跑篩選(改完 config 用這個)
pnpm dry                               # 爬+篩但不寫檔,結果印在終端機
```

`pnpm scan` 後可疊加 flag:`--concurrency N`(平行爬)、`--refilter [日期]`、`--renew`(連看過的也重列)、`--count N`(覆寫滾動量)、`--headless`(無頭)、`--yes`(免確認)。

## 設定 `config/fb-targets.yml`

- `groups:` — 社團清單,`scroll:` 控制每團抓取量。
- `searches:` — 一或多組條件,每篇貼文比對所有組取最佳。判定 = **GATE + SCORE**:`exclude` 命中就丟;其餘按命中欄位評分排序,`include` 全中 → 符合,score≥1 → 待確認。

```yaml
searches:
  - name: "整層住家"
    include:                 # 全中 → 符合
      rent_min: 10000
      rent_max: 33000
      layout: ["兩房一廳"]
      locations: ["信義", "大安"]
    optional:                # 加分:命中越多排越前
      keywords: ["陽台", "洗衣機"]
    exclude:                 # 任一命中就丟掉
      keywords: ["頂加", "出售文"]
      locations: ["三重"]
```

爬取與篩選分離:資料存 `scan-DATE.jsonl`,改條件只要 `--refilter` 不必重爬。去重記在 `data/fb-seen.tsv`(清空重評:`rm data/fb-seen.tsv`)。

## 定時自動跑(launchd,選用)

```bash
cp com.chriswang.fb-scan.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chriswang.fb-scan.plist
launchctl start com.chriswang.fb-scan && tail -20 fb-scan.log   # 立即測一次
```

預設每天 09:00 / 21:00 以 `--yes --headless --concurrency 3` 跑(改 `fb-scan-cron.sh` 的 flag、`plist` 的時間)。無頭**不能重新登入**,session 過期需手動 `pnpm fb-login`。
