# 台股策略實驗室

[![每日行情排程](https://github.com/iankingh/tw-stock-strategy-lab/actions/workflows/daily-price-tracking.yml/badge.svg?branch=main&event=schedule)](https://github.com/iankingh/tw-stock-strategy-lab/actions/workflows/daily-price-tracking.yml?query=branch%3Amain+event%3Aschedule)
[![行情異常稽核](https://github.com/iankingh/tw-stock-strategy-lab/actions/workflows/tracking-incidents.yml/badge.svg?branch=main&event=schedule)](https://github.com/iankingh/tw-stock-strategy-lab/actions/workflows/tracking-incidents.yml?query=branch%3Amain+event%3Aschedule)

追蹤台灣加權指數（`TAIEX`）與六檔台股（`2312`、`2317`、`2330`、`2603`、`3231`、`3481`）的盤前收盤預估、漲跌方向與實際收盤，並提供互動式日 K、44 日葛蘭碧情境走勢、布林通道、MACD 與關鍵 K 線分析。[開啟線上工作站](https://iankingh.github.io/tw-stock-strategy-lab/)

> **本工具僅供技術分析教學與研究參考。模擬結果不代表實際未來走勢，也不構成投資建議。**

[預測模型與發布格式](docs/forecast.md) · [排程、重現與排查](docs/operations.md) · [每月行情 CSV](data/daily-price-tracking) · [排程異常月報](data/tracking-incidents) · [專案協作指引](AGENTS.md)

## 專案目錄結構

```text
tw-stock-strategy-lab/
├── index.html                  # 工作站首頁（GitHub Pages 入口）
├── workstation.js              # 前端 K 線圖、葛蘭碧訊號、情境模擬與報表匯出
├── assets/                     # 預編譯樣式（workstation.css）與第三方授權
├── shared/                     # 網頁與排程共用 ESM 模組（模型、日曆、CSV、指標）
├── scripts/                    # GitHub Actions 執行的排程、補抓、稽核與績效腳本
├── data/                       # 每月盤前／收盤 CSV、五日路徑 JSON、大盤日 K 與異常月報
├── docs/                       # 模型規格（forecast.md）與維運手冊（operations.md）
├── research/                   # 歷史封存行情、回測腳本、研究報告與 parameters/
├── test/                       # Node.js 單元測試
└── .github/workflows/          # 每日行情、備援與異常稽核 GitHub Actions
```

## 快速啟動與部署

### 本機執行

純前端原生 JavaScript 與 SVG，已內附預編譯的 `assets/workstation.css`。在專案根目錄啟動本機靜態伺服器即可開啟：

```sh
git clone https://github.com/iankingh/tw-stock-strategy-lab.git
cd tw-stock-strategy-lab
python3 -m http.server 8000
```

接著開啟 [http://localhost:8000/](http://localhost:8000/)（亦可用 GitHub **Code → Download ZIP** 下載後啟動）。

若修改了 `index.html` 或 `workstation.js` 的 Tailwind 樣式類別，請以 Node.js 24+ 重新編譯 CSS 並一併提交：

```sh
npm ci
npm run build:css
```

### 部署到 GitHub Pages

1. 將專案推送至 `main`，保留根目錄的 `index.html`、`workstation.js` 與 `assets/`、`shared/`、`data/` 相對路徑。
2. 於儲存庫 **Settings → Pages** 將 **Source** 設為 **Deploy from a branch**，選擇 **`main`** 與 **`/(root)`** 並儲存。

## 工作站功能與操作

首頁進站預設顯示台灣加權指數（以「點」計），可切換預設六檔或輸入任意台股代號查詢（個股以「元」計；手機版可展開「選標的」並用「回大盤」返回）。

- **日 K 與 44 日情境走勢**：大盤採同源證交所日 K（`data/taiex.json`）、個股採 FinMind 日 K；右側依 `shared/forecast-model.js`（`workstation-ma20-v2`）產生 44 個交易日模擬走勢與 B2／B3／S4 預設情境點。
- **互動檢視與濾網**：點選 K 線、情境卡片、底部「葛蘭碧八大法則 × 三大濾網」速查表或鍵盤左右鍵即可鎖定交易日並檢視四維度技術訊號；展開「圖層與法則」可調整 MA10／MA20／MA60 與布林通道標準差。
- **模式切換與基準價校正**：可切換「日 K ＋ 情境」與「全週期示範」，並支援「校正基準價」即時重算指標；「盤中行情」可另開證交所基本市況報導網站。
- **報表匯出**：圖表下方可下載含開高低收、均線、布林通道、MACD、葛蘭碧訊號與區間類型的 **CSV** 或 **JSON** 報表。

## 每日自動預測與資料追蹤

網頁與 Node.js 排程共用 [shared/](shared/) 模組，所有交易日與時間均採台灣時間（`Asia/Taipei`，UTC+08:00）：

- **共用模型**：盤前排程與網頁圖表皆使用 `shared/forecast-model.js`（`workstation-ma20-v2`），僅以截至前一交易日收盤的最近 20 個交易日收盤價推算，依乖離率與均線斜率動態判斷漲跌。
- **每日發布**：交易日台灣時間 `06:00`–`09:00` 前由 GitHub Actions 寫入單日預測至 `data/daily-price-tracking/YYYY-MM.csv`、五日路徑至 `data/daily-price-tracking/paths/YYYY-MM-DD.json`；收盤後 `17:00`／`17:45` 補齊實際收盤與 `data/taiex.json` 並觸發 GitHub Pages 更新。
- **模型規則、檔案格式、排程時序、備援與排查指令**請見 [預測模型與發布格式](docs/forecast.md) 與 [排程、重現與排查](docs/operations.md)。歷史統計對照回測保留於 [research/](research/)（[個股回測](research/results.md) · [大盤回測](research/taiex-results.md) · [五日回測](research/five-day-results.md)）。

## 外部看盤參考

以下連結以台積電（2330）為例，可在各平台搜尋其他台股代號：

- [Yahoo 奇摩股市](https://tw.stock.yahoo.com/quote/2330.TW)
- [玩股網 WantGoo](https://www.wantgoo.com/stock/2330/technical-chart)
- [Goodinfo! 台灣股市](https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=2330)
- [TradingView 台股](https://tw.tradingview.com/symbols/TWSE-2330/)

## 授權

本專案程式碼採用 [MIT License](LICENSE)。證交所與 FinMind 行情依各資料來源條款使用（[證交所交易資訊使用規範](https://www.twse.com.tw/zh/products/information/use.html) · [FinMind 文件](https://finmind.github.io/tutor/TaiwanMarket/Technical/)）；預編譯樣式使用 Tailwind CSS，詳見 [第三方授權聲明](assets/tailwind-LICENSE.txt)。
