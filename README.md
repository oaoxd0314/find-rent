# find-rent

FB 租屋社團自動爬取 + 規則篩選。用 Playwright 登入你的 FB、滾動抓貼文、依 `config/fb-targets.yml` 的條件篩選,把結果寫成日期檔。純 Node,零 LLM、不需 API key。

## 安裝

```bash
pnpm install                # 裝 playwright + js-yaml(會順便下載 chromium)
cp config/fb-targets.yml.sample config/fb-targets.yml   # 建立設定檔,再編輯填自己的社團/條件
node fb-scan.mjs --login    # 開瀏覽器,手動登入 FB(含 2FA),登好按 Enter
```

登入狀態存在 `.fb-profile/`,之後不用再登,除非 session 過期。

## 日常使用

```bash
node fb-scan.mjs            # 開瀏覽器 → 只問一次「登入 OK?」→ 自動爬完所有社團
```

結果寫到 `config/fb-targets.yml` 的 `output_dir`(預設 repo 內的 `output/`,已 gitignore):
- `scan-YYYY-MM-DD.md` — 當天**全部**新貼文(✅符合 / 〽️待確認 / ⛔被拒)
- `find-YYYY-MM-DD.md` — 當天**命中清單**(符合 + 待確認)

看過的貼文會去重(`data/fb-seen.tsv`),不重複。

### 模式
| 指令 | 用途 |
|------|------|
| `node fb-scan.mjs --dry-run` | 爬+篩但不寫檔,印終端機 |
| `node fb-scan.mjs --yes` | 不問,確認登入就直接爬 |
| `node fb-scan.mjs --headless` | 無頭(排程用) |
| `node fb-scan.mjs --login` | 重新登入 FB |

## 改條件 / 社團

編輯 `config/fb-targets.yml`:
- `groups:` — 要爬的社團(`enabled: false` 可暫停)
- `searches:` — 條件(租金、格局、排除關鍵字/地點)
- `output_dir:` — 結果寫去哪

清空重評全部:`rm data/fb-seen.tsv`

## 定時自動跑(launchd,選用)

```bash
cp ~/Code/Personal/find-rent/com.chriswang.fb-scan.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chriswang.fb-scan.plist
launchctl start com.chriswang.fb-scan          # 馬上測一次
tail -20 ~/Code/Personal/find-rent/fb-scan.log
```

預設每天 09:00 / 21:00 跑(`--yes --headless`)。改時間編輯 plist 的 `Hour`/`Minute` 後 `launchctl unload` 再 `load`。移除:`launchctl unload …` 後刪檔。

注意:無頭背景跑**不能重新登入**,session 過期時 log 會顯示「未登入」,手動 `node fb-scan.mjs --login` 重登即可。

## 結構
```
fb-scan.mjs              主程式
config/fb-targets.yml    社團 + 條件
data/fb-seen.tsv         去重記錄(gitignored)
.fb-profile/             FB 登入 cookie(gitignored,勿刪)
fb-scan-cron.sh          launchd wrapper(gitignored)
com.chriswang.fb-scan.plist  launchd 設定(gitignored)
```
