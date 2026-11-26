# 排程、重現與排查

所有交易日、工作摘要、排程時段與匯出時間統一採台灣時間（`Asia/Taipei`，UTC+08:00），開休市日曆維護於 [shared/trading-calendar.js](../shared/trading-calendar.js)（目前涵蓋 2026–2027 年）。

## 開發與檢查指令

使用 Node.js 24+，在專案根目錄執行：

```sh
node --test
npm run build:css
tsc -p jsconfig.json
python3 -m http.server 8000
```

- `node --test`：執行全部單元測試（涵蓋模型、CSV 解析、盤前邊界、收盤補抓、五日核對與工作站前端）。
- `npm run build:css`：修改 `index.html` 或 `workstation.js` 的 Tailwind 類別後重建 `assets/workstation.css`。
- `tsc -p jsconfig.json`：檢查 `shared/` 共用模組 JSDoc 型別（需本機安裝 TypeScript CLI）。
- 本機開啟 [http://localhost:8000/](http://localhost:8000/) 以桌面與手機視窗核對大盤與個股切換、44 日走勢、日期選取與匯出。

### 實盤績效與歷史回測

```sh
node scripts/live-performance.mjs 2026-11-26 2026-11-30
node research/backtest.mjs
node research/taiex-backtest.mjs
node research/five-day-backtest.mjs
```

- `live-performance.mjs` 依每月 CSV 統計大盤與個股的盤前準時率、已配對誤差與方向命中率。
- `research/` 三支回測腳本讀寫 [research/parameters/](../research/parameters/) 內的歷史研究參數（`backtest.mjs` 與 `five-day-backtest.mjs` 加上 `--write` 才寫檔）。

## 每日排程時序（台灣時間）

主工作流程（`.github/workflows/daily-price-tracking.yml`）與備援工作流程（`premarket-recovery.yml`）共用同一寫入佇列，成功更新後自動提交至 `main` 並觸發 GitHub Pages 重建。

| 台灣時間 | 工作內容 |
| --- | --- |
| `04:00`–`05:59` | 備援排程若於此區間啟動，安排唯讀待命等到 `06:00` 準時補盤前預測 |
| `06:00`–`08:59` | **正式盤前寫入時段**；主排程 `07:00`、`07:20` 與備援 `06:43`、`07:11`、`07:41`、`08:11`、`08:41` 依缺項補寫單日 CSV 與五日 JSON |
| `09:15` | 盤前稽核（`audit`），檢查 7 檔單日與 35 個五日目標價是否齊全，缺漏時標示失敗 |
| `15:00`–`16:59` | 備援排程提早啟動時安排待命等到 `17:00` 補收盤 |
| `17:00`、`17:45` | 查詢證交所 OpenAPI／全市場收盤表／月報（個股備援 FinMind）補寫當日實際收盤與 `data/taiex.json` |

- 盤前預測必須在 `06:00:00` 起、`09:00:00` 前開始並完成；逾時留白、重跑保留已發布的原值與時間。
- 資料部分成功時先保存成功項，缺項列入 Actions 摘要與 [每月異常紀錄](../data/tracking-incidents)。

## 手動核對與排查

```sh
node scripts/daily-price-tracking.mjs verify YYYY-MM-DD
node scripts/daily-price-tracking.mjs audit YYYY-MM-DD
node scripts/daily-price-tracking.mjs check-paths YYYY-MM-DD
node scripts/daily-price-tracking.mjs check-recovery
```

- `verify`：唯讀驗證指定已收盤交易日的 FinMind／證交所連線與 7 檔模型計算，不修改 CSV。
- `audit`：於當日 `09:00` 後唯讀核對單日 CSV 與五日 JSON 缺漏。
- `check-paths`：發布後立即核對 7 個標的、35 個有效目標價、交易日次序、產生時間，以及第 1 天與 CSV 的價格、方向、版本一致性。
- `check-recovery`：唯讀檢視依當前台灣時間是否需要待命或補跑。

發現缺項時，先檢視 GitHub Actions 摘要中的台灣啟動時間、缺漏代號與來源錯誤，再對照 [每月異常紀錄](../data/tracking-incidents)。交易日 `09:00` 前可在 Actions 手動觸發 `forecast` 補缺項；收盤缺漏則可隨時以 `retry` 補抓。五日路徑與稽核起算日為 `2026-11-26`。
