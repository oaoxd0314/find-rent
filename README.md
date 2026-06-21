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
scan(爬 + 抽 meta) ──▶ scan-YYYY-MM-DD.jsonl   資料層(機器用)
                  └──▶ filter(套 config) ──▶ find-YYYY-MM-DD.md   人眼版
```

- 篩選與爬取分離:改條件只要 `--refilter`,不必重爬。
- 去重記在 `data/fb-seen.tsv`,看過的不重列;清空重評全部:`rm data/fb-seen.tsv`。

輸出在 config 的 `output_dir`(預設 `output/`):

- `scan-*.jsonl` — 當天去重後的貼文 + 抽好的 meta,可重複篩選。
- `find-*.md` — 命中清單,依判定由好到差分區:
  - `符合` — include 條件全中。
  - `待確認` — 沒被排除,但某些 include 沒滿足(租金/格局/地點/設備)。
  - `性別待確認` — 偵測到男性訊號(`roommate_male` 條件用)。
  - 命中 exclude、買賣文、求租文 → 直接排除,不進 find(仍保留在 jsonl)。

## 設定

編輯 `config/fb-targets.yml`:

- `groups:` — 社團清單。`enabled: false` 暫停某個;`scroll:` 控制抓取量。
- `searches:` — 一或多組條件,每篇貼文比對所有組、取最佳結果:
  - `include:` `rent_min` / `rent_max` / `layout` / `locations` / `must_have` — 軟條件,沒中只降「待確認」,不丟掉。
  - `exclude:` `keywords` / `locations` — 命中就排除;`roommate_male: true` — 偵測男室友/限男 → 性別待確認。
  - `optional:` — 加分項,只在命中時標註。

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
