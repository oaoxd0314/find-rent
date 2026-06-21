# find-rent

爬 FB 租屋社團、依 `config/fb-targets.yml` 的條件篩選,輸出每日 Markdown。

## 安裝

```bash
pnpm install
cp config/fb-targets.yml.sample config/fb-targets.yml   # 填自己的社團/條件
pnpm fb-login                                           # 開瀏覽器登入 FB,登好按 Enter
```

> 登入用 `pnpm fb-login`,不是 `pnpm login`(那是登 npm)。

## 使用

```bash
pnpm scan          # 爬完所有社團,結果寫到 output_dir
pnpm scan --renew  # 跳過跨次去重(fb-seen 不擋),需要重新看到結果時用
pnpm scan:log      # 免確認跑 + 同步寫 fb-scan.log(跑完即走、之後 tail 看);吃不了額外參數
pnpm dry           # 只印終端機,不寫檔

node fb-scan.mjs --refilter              # 不開瀏覽器,用今天的 scan 資料重跑篩選
node fb-scan.mjs --refilter 2026-06-21   # 指定日期重跑
```

> 改了 `config/fb-targets.yml` 的條件後,不用重爬 FB —— `--refilter` 直接讀當天的 `scan-*.jsonl` 重生 `find-*.md`。

`pnpm scan` 會開瀏覽器、開到第一個社團,**只問一次**「登入 OK?按 Enter」,確認後自動爬完所有社團。不想被問就用:

```bash
node fb-scan.mjs --yes      # 確認登入後直接爬,不互動
```

結果在 `config/fb-targets.yml` 設定的 `output_dir`:

- `scan-YYYY-MM-DD.jsonl` — 當天去重後的新貼文 + 抽好的 meta(資料層,機器用,可重跑篩選)
- `find-YYYY-MM-DD.md` — 套條件後的命中清單(✅符合 + 〽️待確認),人眼看的版本

資料流:`scan(爬+抽 meta)→ jsonl → filter(套 config 判斷)→ find.md`。
篩選與爬取分離 —— 改條件只要 `--refilter`,不必重爬。

看過的貼文會跨次去重(記在 `data/fb-seen.tsv`),不重複列出。
想無視這個去重、重新把看過的也拉出來,用 `--renew` ——
`fb-seen` 照樣維護,只是不拿它擋結果;當天 jsonl 內仍會避免重複行。

session 過期時 log 會顯示「未登入」,重登:`pnpm fb-login`。

## 改條件 / 社團

編輯 `config/fb-targets.yml`:

- `groups:` — 社團清單(`enabled: false` 暫停某個)
- `searches:` — 篩選條件(租金、格局、排除字詞等)

清空去重紀錄、重評全部貼文:`rm data/fb-seen.tsv`

## 定時自動跑(launchd,選用)

```bash
cp com.chriswang.fb-scan.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chriswang.fb-scan.plist
launchctl start com.chriswang.fb-scan          # 馬上測一次
tail -20 fb-scan.log
```

預設每天 09:00 / 21:00(`--yes --headless`)。改時間編 plist 的 `Hour`/`Minute`,再 `launchctl unload` → `load`。移除:`launchctl unload …` 後刪檔。

**必知:**

1. 背景無頭跑**不能重新登入** — session 過期時 log 顯示「未登入」,手動 `pnpm fb-login` 重登。
2. 電腦睡眠中錯過的排程會在喚醒後補跑一次;關機則跳過。
3. 全自動 = 無確認。想在旁邊看著登入就別裝排程,維持手動跑。
