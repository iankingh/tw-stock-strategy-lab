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

工作站使用原生 JavaScript、SVG 和 Tailwind CSS CDN。請保留解壓後的目錄結構，首頁會從 `data/taiex.js` 載入證交所大盤日 K。Tailwind CSS、Google Fonts 和 FinMind 日 K 資料會透過網路載入。

## 操作方式

1. 進站與重新整理時預設顯示台灣加權指數。點選個股或輸入代號查日 K，手機可展開「選標的」，並用「回大盤」一鍵返回。
2. 點選 K 線可鎖定交易日，圖表和側欄會顯示該日指標。使用「前一日」、「後一日」或鍵盤左右方向鍵切換。按 Home 或「回基準日」即可返回。
3. 展開圖表下方的「圖層與法則」調整均線、布林通道及其他圖層，或定位葛蘭碧訊號。點選側欄的情境點也可定位對應日期。

大盤以點顯示，個股以元顯示。行情摘要顯示證交所大盤日 K 或 FinMind 個股日 K 與每日收盤紀錄中最新的實際收盤價，並標明交易日與來源。「盤中行情」會另開證交所基本市況報導網站。當日盤前紀錄另列預估收盤、方向及台灣時間。用本機檔案直接開啟時，可在專案目錄執行 `python3 -m http.server 8000`，再用瀏覽器開啟 [本機工作站](http://localhost:8000/) 讀取 CSV。

## 資料來源與情境

- **歷史日 K**　圖表最多顯示最近 56 筆，並使用更早的 FinMind 日 K 計算指標。查詢失敗時，同一檔股票已有快取就顯示該份資料與交易日期。
- **歷史 B2**　所選均線上揚、前一日收盤回落且位於當日均線上方 0–2.2%、當日收盤回升且守住均線時，標記回測買點。
- **示範資料**　點選「全週期示範」可開啟內建模擬圖。查無歷史資料時，可重試、切換標的或主動開啟示範。
- **資料不足**　均線使用完整的交易日筆數。資料不足時顯示 `—`，CSV 留空，JSON 為 `null`。開始產生未來情境前，基準日須有足夠資料計算所選均線。
- **未來路徑**　取台灣今天與最新 FinMind 交易日中較晚的一天，從下一個開市日開始產生 44 根模擬 K 線。B2、B3、S4 是模型安排在固定交易日的預設情境點。日曆涵蓋不足時，保留已取得的歷史日 K 並暫停模擬。
- **手動校正**　套用「校正基準價」後，圖表會標出校正狀態並重算指標。重新取得該檔 FinMind 日 K 後會使用原始收盤價。

## 檔案匯出

在圖表下方選擇 **下載 CSV** 或 **下載 JSON**。

| 格式 | 內容 |
| --- | --- |
| CSV | 匯出目前圖表的日期、開高低收、均線、布林通道、MACD、葛蘭碧訊號與 K 線型態，可用 Excel 開啟。「區間類型」會標示歷史日 K、手動校正、示範資料和未來情境模擬。預設情境點也會明確標示。 |
| JSON | 包含匯出時間、情境日期、標的資訊、均線與布林通道參數，以及目前圖表的 K 線。每根 K 線的 `sourceLabel` 與 CSV 的「區間類型」一致。 |

JSON 每根 K 線的 `selectedMA`、`selectedBiasPct` 及標的摘要的 `selectedMACurrent` 都依 `parameters.maPeriod` 計算。舊欄位 `ma20`、`bias20`、`ma20Current` 分別是這三個值的相容別名。

## 每日預測與收盤紀錄

排程、工作摘要、行情交易日與匯出時間統一採台灣時間（`Asia/Taipei`，UTC+08:00）。JSON 的 `exportedAt` 使用帶有 `+08:00` 的 ISO 8601 時間。GitHub Actions 追蹤 2312、2317、2330、2603、3231、3481 六檔上市股票及加權指數（CSV 代號 `TAIEX`）。每月一份 CSV 存在 [`data/daily-price-tracking/`](https://github.com/iankingh/tw-stock-strategy-lab/tree/main/data/daily-price-tracking)，檔名以交易日的年月組成，例如 `2026-11.csv`。

欄位依序為「交易日、股票代號、預測收盤價、預測時間、實際收盤價、收盤價取得時間、策略版本、昨收、預測方向」。既有紀錄可讀取，舊預測沒有記錄的欄位留空。

| 台灣時間 | 記錄工作 |
| --- | --- |
| 07:00 | 以截至前一交易日的大盤或個股日 K 分別估計收盤價與漲跌平，記錄昨收與模型版本。盤前工作摘要會列出台灣實際啟動時間。 |
| 07:20 | 補跑缺漏的盤前預測。已記錄的預測保留原值和時間。 |
| 07:11、07:41、08:11、08:41 | GitHub 備援檢查當日 CSV，缺預測時才啟動補跑。 |
| 09:15 | 檢查啟用中的標的盤前預測是否齊全。GitHub Actions 摘要會列出完成數量與缺漏股票代號，缺漏時工作標示失敗。 |
| 17:00 | 查詢證交所當天的實際收盤價，依交易日期和股票代號補上同一列。 |
| 17:45 | 重查未取得的收盤價，並處理前七天已有紀錄的缺值。個股可用日期吻合的 FinMind 日 K 補抓，大盤採證交所月報。先提交取得的價格，再檢查缺漏；仍有缺值會列出日期與代號，工作標示失敗。 |

GitHub 可能延遲建立排程事件。「台股盤前與收盤備援」另在 12:23 至 21:23、22:43 至隔日 06:43 每小時安排檢查，並依工作實際啟動的台灣時間判斷應補的資料。交易日 07:00 至 09:00 前檢查當天盤前預測。17:00 至隔日 07:00 前檢查最近已收盤交易日的六檔個股與大盤，缺值才呼叫收盤補抓，跨月仍寫回原交易月份。可在 Actions 手動執行備援查看摘要。所有觸發都由 GitHub 提供，平台延遲仍可能影響準時率。

排程依證交所日曆判斷休市。CSV 以 `YYYY-MM-DD HH:mm:ss` 記錄實際台灣時間。若盤前工作延遲到 09:00 之後，或歷史資料未更新至前一交易日，預測欄會留空。資料延遲時收盤價欄會留空，補抓時會寫回原交易月份。

在 GitHub Actions 的「台股每日股價紀錄」可選 **Run workflow**。`audit` 可指定交易日，唯讀檢查已記錄的盤前預測。`verify` 用已收盤的交易日檢查資料來源和預測計算，`retry` 可指定交易日補抓收盤價。

工作站和排程共用 `trading-calendar.js` 裡的證交所日曆，目前涵蓋 2026、2027 年。證交所公布新年度日曆或調整開休市日期時，在檔案中更新該年的 `open` 與 `closed` 清單，日期使用 `MM-DD`。列出的例外優先於平日及週末規則。排程遇到尚未收錄的年份時會查詢證交所 API。

[證交所交易日曆](https://www.twse.com.tw/zh/trading/holiday.html) · [證交所日成交資訊](https://www.twse.com.tw/zh/trading/historical/stock-day.html) · [FinMind 日成交資訊](https://finmind.github.io/tutor/TaiwanMarket/Technical/) · [GitHub Actions 排程說明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 準確度與準時率

盤前收盤價採用昨收，方向由三類邏輯迴歸獨立估計。2026 年截至 11 月 17 日的保留期涵蓋六檔各 210 個交易日，六檔等權價格誤差占昨收 2.403%（舊情境公式 2.478%），方向命中率 48.254%（訓練期多數方向 47.698%）。方向模型在這段期間沒有命中平盤日。逐檔價格、方向、樣本數與採用規則見[完整回測](research/results.md)。

在專案根目錄以 Node.js 24 以上執行：

```sh
node research/backtest.mjs
node scripts/live-performance.mjs 2026-11-17 2026-11-18
node --test
```

第一個指令使用封存行情重跑。第二個指令可自訂起訖日，用當月 CSV 計算盤前準時交付檔數、六檔全數準時的交易日數，以及各版本已有實際收盤價的誤差與方向命中率。完整缺席的交易日也計入準時率分母。2026-11-17 是排程啟用後的首個盤前交易日。

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

## 大盤預測與實盤績效

大盤首頁使用證交所日 K 與均線。「盤前預測」顯示當日已寫入的點位、方向與台灣時間，「盤中行情」可另開證交所網站。歷史回測與實際盤前紀錄分開保存。[證交所加權指數歷史資料](https://www.twse.com.tw/zh/indices/taiex/mi-5min-hist.html)

```sh
node research/taiex-backtest.mjs
node scripts/taiex.mjs 2023-01-01 2026-11-18
```

第一行用本地行情與封存交易日重算大盤模型參數和結果表。第二行從證交所重抓指定日期範圍的日 K。2026 年截至 11 月 17 日的 210 個交易日，採用昨收點位的平均絕對誤差為 600.69 點（昨收的 1.483%）。方向基準固定預測「漲」，命中 114 天（54.286%），96 個下跌日均未命中。[完整大盤回測與逐類命中數](research/taiex-results.md)

功能進入 main 後，工作流程在 `data/taiex-start.txt` 記下首個應交付的大盤交易日。交易日 09:00 前啟用從當天起算，其餘順延至下一個可交付交易日。收盤補抓會同步保存同源日 K，每月 CSV 使用現有欄位。排程提交行情變更後會要求 GitHub Pages 重新建置首頁。`node scripts/live-performance.mjs 起日 迄日` 分別列出大盤與六檔個股的準時率、已配對誤差及方向命中率。
