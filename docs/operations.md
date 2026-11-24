# 排程、重現與排查

## 執行檢查

使用 Node.js 24，在專案根目錄執行。型別檢查需要 TypeScript CLI。

```sh
node --test
tsc -p jsconfig.json
node research/backtest.mjs
node research/taiex-backtest.mjs
node research/five-day-backtest.mjs
python3 -m http.server 8000
```

大盤回測會重寫既有參數與報告。個股與五日回測預設輸出到終端，加上 `--write` 才寫檔。同一批封存行情應產生相同版本與報告。瀏覽本機首頁核對大盤與個股的切換、日期選取及教學入口。

## 每日核對

盤前時段為交易日台灣時間 06:00 起、09:00 前。每日行情與備援使用同一寫入佇列。成功項隨單日 CSV 提交到 main，GitHub Pages 以同一版發布。工作摘要分列單日與五日的完成數；收盤流程另行補實際收盤。

```sh
node scripts/daily-price-tracking.mjs audit YYYY-MM-DD
node scripts/daily-price-tracking.mjs check-paths YYYY-MM-DD
```

`audit` 在當日截止後分別核對單日與五日紀錄。`check-paths` 可於發布後立即唯讀核對：七個標的、35 個有效目標價、交易日次序、產生時間，以及第 1 天與 CSV 的價格、方向、模型版本。

發現缺項時先看 Actions 的台灣啟動時間、缺漏代號、來源錯誤，再查看[每月稽核紀錄](../data/tracking-incidents)。交易日盤前可用 `forecast` 補缺項，已發布資料保留原值與時間。截止後缺漏保留空白。首次適用日為 2026-11-25；較早日期僅追蹤既有單日預測。

首個適用交易日 09:00 後，GitHub 的行情異常稽核會在該月月報保存五日預估核對結果。七檔齊全時記載 35 個目標價及第 1 天 CSV 已通過檢查；缺漏時記載實際缺少的標的。此驗收由 GitHub 執行。
