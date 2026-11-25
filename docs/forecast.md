# 預估收盤與五日走勢

首頁追蹤加權指數與六檔個股，並直接呈現日 K、均線、44 日葛蘭碧情境走勢、四維度技術訊號與「葛蘭碧八大法則 × 三大濾網」速查表。頂部「盤前預測」讀取已發布的每月 CSV，顯示當日準時記錄的預估收盤、方向與台灣時間。

## 正式模型

盤前排程與網頁圖表共用 `shared/forecast-model.js`（`workstation-ma20-v1`），以截至前一交易日收盤的最近 20 個交易日收盤價計算未來走勢。單日紀錄取第 1 個交易日預測收盤價，並依其相對昨收決定漲跌平方向；五日路徑檔依序記錄未來 5 個交易日的預測收盤價（方法標示為 `scenario`）。歷史已發布的 `previous` 與 `ridge` 紀錄仍相容保留且不覆寫。

歷史統計回測（2023–2024 年訓練、2025 年驗證、2026 年截至 11 月 17 日驗收）保留於 [五日回測](../research/five-day-results.md) 供研究對照。

## 發布資料

- 單日紀錄保存在 `data/daily-price-tracking/YYYY-MM.csv`，保留既有中文表頭與欄序。個股使用元，大盤使用點。
- 自 2026-11-25 起，`data/daily-price-tracking/paths/YYYY-MM-DD.json` 按發布日存檔。最外層以股票代號或 `TAIEX` 為鍵。部分成功時只出現已發布標的。
- 每筆含 `trade_date`、`stock_id`、台灣時間 `generated_at`、行情截至日 `history_through`、五日 `model_version`、單日 `daily_model_version` 及首日 `direction`。`targets` 依序包含五個交易日的 `date`、數值 `close`、方法 `method`。方法值 `scenario` 為共用葛蘭碧／MA20 情境模型，`previous`（基準收盤）與 `ridge`（正則化迴歸）保留相容歷史紀錄。
- 同目錄 `latest.json` 以標的代號指向其最近發布日期。
