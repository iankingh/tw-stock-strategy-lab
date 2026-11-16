# 台股策略實驗室

台股技術分析與情境模擬工作站，整合葛蘭碧八大法則、布林通道、MACD 與 K 線型態。透過互動圖表比較技術指標與訊號，並下載目前的圖表資料。

## 如何開啟工作站

- **本機開啟**　從 GitHub 的 **Code → Download ZIP** 下載並解壓縮，用瀏覽器開啟裡面的 `index.html`。[下載專案 ZIP](https://github.com/iankingh/tw-stock-strategy-lab/archive/refs/heads/main.zip)
- **線上開啟**　完成 [GitHub Pages 部署](#部署到-github-pages)後，可直接開啟 [台股策略實驗室](https://iankingh.github.io/tw-stock-strategy-lab/)。

也可以用 Git 下載原始碼，然後用瀏覽器開啟 [`index.html`](index.html)。

```sh
git clone https://github.com/iankingh/tw-stock-strategy-lab.git
cd tw-stock-strategy-lab
```

介面、圖表和指標計算集中在同一個 HTML 檔，使用原生 JavaScript、SVG 和 Tailwind CSS CDN，開啟前無需安裝 Node.js 或執行建置。Tailwind CSS、Google Fonts 和 FinMind 日 K 資料會透過網路載入。

## 操作方式

1. 選擇預設標的，或輸入台股代號（例如 `2330`）。
2. 選擇圖表情境，並調整均線週期、布林通道標準差。
3. 將游標移到 K 線查看該日的指標，或點擊葛蘭碧法則卡片定位訊號。

## 資料來源與情境

- **歷史日 K**　近期走勢模式會嘗試從 FinMind 的 `TaiwanStockPrice` 資料集取得歷史日 K。
- **示範資料**　FinMind 請求失敗或回傳資料不足時，圖表會使用內建模擬資料。完整多空循環模式也使用模擬資料來展示訊號。
- **未來路徑**　圖上的未來約兩個月走勢由程式產生，用來展示可能的策略情境。

## 檔案匯出

| 格式 | 內容 |
| --- | --- |
| HTML | 下載工作站網頁 `index.html`，可直接用瀏覽器開啟。 |
| CSV | 匯出目前圖表的日期、區間、開高低收、均線、布林通道、MACD、葛蘭碧訊號與 K 線型態，可用 Excel 開啟。每列的「區間類型」用於區分圖表上的歷史、基準和未來區間。使用示範資料時，歷史區間也由程式模擬。 |
| JSON | 包含匯出時間、情境日期、標的資訊、均線與布林通道參數，以及目前圖表的 K 線資料。 |

「Python 腳本」分頁可複製依目前標的和參數產生的程式。腳本使用 `yfinance` 下載日 K，計算技術指標，並以 `mplfinance` 繪製 K 線與成交量。本機執行前可用 `python -m pip install yfinance pandas mplfinance numpy` 安裝套件。

## 部署到 GitHub Pages

1. 將 `index.html` 放在 GitHub 儲存庫的 `main` 分支根目錄。
2. 在儲存庫開啟 **Settings → Pages**，將 **Source** 設為 **Deploy from a branch**。
3. 選擇 **`main`** 和 **`/(root)`**，按 **Save**。部署完成後可從 Pages 設定頁開啟網站。

[GitHub Pages 發布設定文件](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

本工具僅供技術分析教學與研究參考。模擬結果不代表實際未來走勢，也不構成投資建議。
