# 台股策略實驗室協作指引

- 先讀 [預測模型與發布格式](docs/forecast.md) 和 [排程、重現與排查](docs/operations.md)。使用繁體中文維護介面、文件與 Conventional Commit。
- 正式盤前與網頁 44 日走勢推算共用 `shared/forecast-model.js`（`workstation-ma20-v2`），方向判定與回測工具用 `shared/daily-model.js`，發布日期與五日有效性用 `shared/five-day.js`，單日紀錄用 `shared/premarket.js`。網站讀取已發布的 CSV 顯示盤前預測。
- 交易日期、工作摘要與截止時間採 Asia/Taipei。正式預測限交易日 06:00 起、09:00 前開始且完成。推算只用截至前一交易日的行情。
- 重跑時保留已發布的預測值、時間、方向與模型版本。資料部分成功時先存成功項，缺項列入 Actions 與月報。歷史發布檔與回測產物分開。
- 修改模型時重跑單日、大盤、五日回測並比對版本與報告。修改排程時驗證時段邊界、部分失敗和重跑。修改圖表時以桌面與手機檢查日期選取、缺口與快速切換。共用型別檢查與 Node 測試指令見操作文件。
