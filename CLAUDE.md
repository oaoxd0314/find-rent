# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Usage

```bash
pnpm install                      # 環境設置
cp config/fb-targets.yml.sample config/fb-targets.yml   # 設置你的 config
node fb-scan.mjs --login          # login fb
node fb-scan.mjs                  # 開始找房
```

## 自動化 cron job

預設每天 09:00 / 21:00 自動跑(`--yes --headless`)。

1. 安裝排程:
   ```bash
   cp com.chriswang.fb-scan.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.chriswang.fb-scan.plist
   ```
2. 馬上測一次:
   ```bash
   launchctl start com.chriswang.fb-scan
   tail -20 fb-scan.log
   ```
3. 改時間:編輯 plist 的 `Hour` / `Minute`,再 `launchctl unload` → `load`。
4. 移除:`launchctl unload ~/Library/LaunchAgents/com.chriswang.fb-scan.plist` 後刪檔。

> headless **不能重登**。session 過期時 log 會顯示「未登入」,手動 `node fb-scan.mjs --login` 重登。
