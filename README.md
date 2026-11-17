# 台股策略實驗室

台股技術分析與情境模擬工作站，整合葛蘭碧八大法則、布林通道、MACD 與 K 線型態。透過互動圖表比較技術指標與訊號，並下載目前的圖表資料。

## 如何開啟工作站

- **線上開啟**　[前往台股策略實驗室](https://iankingh.github.io/tw-stock-strategy-lab/)。
- **本機開啟**　從 GitHub 的 **Code → Download ZIP** 下載並解壓縮，用瀏覽器開啟裡面的 `index.html`。[下載專案 ZIP](https://github.com/iankingh/tw-stock-strategy-lab/archive/refs/heads/main.zip)

也可以用 Git 下載原始碼，然後用瀏覽器開啟 [`index.html`](index.html)。

```sh
git clone https://github.com/iankingh/tw-stock-strategy-lab.git
cd tw-stock-strategy-lab
```

工作站使用原生 JavaScript、SVG 和 Tailwind CSS CDN。把 `index.html`、`forecast-model.js` 和 `trading-calendar.js` 放在同一個目錄，即可用瀏覽器開啟。Tailwind CSS、Google Fonts 和 FinMind 日 K 資料會透過網路載入。

## 操作方式

1. 選擇預設標的，或輸入台股代號（例如 `2330`）並按「查日 K」。
2. 選擇圖表情境，並調整均線週期、布林通道標準差。
3. 將游標移到 K 線查看該日的指標，或點擊葛蘭碧法則卡片定位訊號。當前圖表沒有該訊號時，會顯示提示。

## 資料來源與情境

- **歷史日 K**　圖表最多顯示最近 56 筆，並使用更早的 FinMind 日 K 計算指標。查詢失敗時，同一檔股票已有快取就顯示該份資料與交易日期。
- **示範資料**　點選「葛蘭碧全週期示範」可開啟內建模擬圖。查無歷史資料時，可重試、切換標的或主動開啟示範。
- **資料不足**　均線使用完整的交易日筆數。資料不足時顯示 `—`，CSV 留空，JSON 為 `null`。開始產生未來情境前，基準日須有足夠資料計算所選均線。
- **未來路徑**　取台灣今天與最新 FinMind 交易日中較晚的一天，從下一個開市日開始產生 44 根模擬 K 線。B2、B3、S4 是模型安排在固定交易日的預設情境點。日曆涵蓋不足時，保留已取得的歷史日 K 並暫停模擬。
- **手動校正**　套用「校正基準價」後，圖表會標出校正狀態並重算指標。重新取得該檔 FinMind 日 K 後會使用原始收盤價。

## 檔案匯出

在圖表下方選擇 **下載 CSV** 或 **下載 JSON**。

| 格式 | 內容 |
| --- | --- |
| CSV | 匯出目前圖表的日期、開高低收、均線、布林通道、MACD、葛蘭碧訊號與 K 線型態，可用 Excel 開啟。「區間類型」會標示歷史日 K、手動校正、示範資料和未來情境模擬。預設情境點也會明確標示。 |
| JSON | 包含匯出時間、情境日期、標的資訊、均線與布林通道參數，以及目前圖表的 K 線。每根 K 線的 `sourceLabel` 與 CSV 的「區間類型」一致。 |

## 每日預測與收盤紀錄

GitHub Actions 以台灣時間執行，追蹤 2312、2317、2330、2603、3231、3481 六檔上市股票。每月一份 CSV 存在 [`data/daily-price-tracking/`](https://github.com/iankingh/tw-stock-strategy-lab/tree/main/data/daily-price-tracking)，檔名以交易日的年月組成，例如 `2026-11.csv`。

欄位依序為「交易日、股票代號、預測收盤價、預測時間、實際收盤價、收盤價取得時間、策略版本」。

| 時間 | 記錄工作 |
| --- | --- |
| 06:00 | 以截至前一交易日的 FinMind 日 K 和工作站的 20 日均線情境模型，計算當天預測收盤價並記錄策略版本。 |
| 06:20、07:20 | 若還有缺少的盤前預測，重新嘗試。已記錄的預測保留原值和時間。 |
| 09:15 | 檢查六檔盤前預測是否齊全。GitHub Actions 摘要會列出完成數量與缺漏股票代號，缺漏時工作標示失敗。 |
| 17:00 | 查詢證交所當天的實際收盤價，依交易日期和股票代號補上同一列。 |
| 17:45 | 重查未取得的收盤價，並處理前七天已有紀錄的缺值。證交所尚未提供時，以日期吻合的 FinMind 日 K 補抓。 |

排程依證交所日曆判斷休市。CSV 以 `YYYY-MM-DD HH:mm:ss` 記錄實際台灣時間。若盤前工作延遲到 09:00 之後，或歷史資料未更新至前一交易日，預測欄會留空。資料延遲時收盤價欄會留空，補抓時會寫回原交易月份。

在 GitHub Actions 的「台股每日股價紀錄」可選 **Run workflow**。`audit` 可指定交易日，唯讀檢查已記錄的盤前預測。`verify` 用已收盤的交易日檢查資料來源和預測計算，`retry` 可指定交易日補抓收盤價。

工作站和排程共用 `trading-calendar.js` 裡的證交所日曆，目前涵蓋 2026、2027 年。證交所公布新年度日曆或調整開休市日期時，在檔案中更新該年的 `open` 與 `closed` 清單，日期使用 `MM-DD`。列出的例外優先於平日及週末規則。排程遇到尚未收錄的年份時會查詢證交所 API。

[證交所交易日曆](https://www.twse.com.tw/zh/trading/holiday.html) · [證交所日成交資訊](https://www.twse.com.tw/zh/trading/historical/stock-day.html) · [FinMind 日成交資訊](https://finmind.github.io/tutor/TaiwanMarket/Technical/) · [GitHub Actions 排程說明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 外部看盤參考

以下連結以台積電（2330）為例。可在各平台搜尋其他台股代號。

- [Yahoo 奇摩股市](https://tw.stock.yahoo.com/quote/2330.TW)
- [玩股網 WantGoo](https://www.wantgoo.com/stock/2330/technical-chart)
- [Goodinfo! 台灣股市](https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=2330)
- [TradingView 台股](https://tw.tradingview.com/symbols/TWSE-2330/)

## 部署到 GitHub Pages

1. 將 `index.html` 放在 GitHub 儲存庫的 `main` 分支根目錄。
2. 在儲存庫開啟 **Settings → Pages**，將 **Source** 設為 **Deploy from a branch**。
3. 選擇 **`main`** 和 **`/(root)`**，按 **Save**。部署完成後可從 Pages 設定頁開啟網站。

[GitHub Pages 發布設定文件](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

本工具僅供技術分析教學與研究參考。模擬結果不代表實際未來走勢，也不構成投資建議。
