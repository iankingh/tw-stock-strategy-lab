# 預測模型與發布格式

首頁追蹤台灣加權指數（`TAIEX`）與六檔個股（`2312`、`2317`、`2330`、`2603`、`3231`、`3481`），直接呈現日 K、均線、44 日葛蘭碧情境走勢、四維度技術訊號與「葛蘭碧八大法則 × 三大濾網」速查表。頂部「盤前預測」讀取已發布的每月 CSV，顯示當日準時記錄的預估收盤、方向與台灣時間。

## 正式模型（`workstation-ma20-v2`）

盤前排程與網頁 44 日圖表共用 [shared/forecast-model.js](../shared/forecast-model.js)（`forecastClosePath`），只使用截至前一交易日收盤的最近 20 個交易日（`maPeriod = 20`）收盤價，確保網頁與排程推算完全一致。

### 第一段（第 1–11 個交易日）方向規則

計算基準收盤相對 MA20 的乖離率 `bias = ((lastClose - average) / average) * 100`，並比較視窗後半與前半均價判斷均線斜率：

| 條件 | 盤勢判讀 | 第 11 日目標 | 首日方向 |
| --- | --- | --- | --- |
| `bias > +2.2%` | 正乖離過大（短線過熱） | `average * 1.012`（拉回均線） | 跌 |
| `bias < -2.2%` | 負乖離過大（B4 超跌） | `average * 0.988`（反彈向均線） | 漲 |
| `-2.2% <= bias <= +2.2%` 且均線上揚 | 均線附近偏多 | `lastClose * 1.025` | 漲 |
| `-2.2% <= bias <= +2.2%` 且均線下彎 | 均線附近偏空 | `lastClose * 0.975` | 跌 |

- **單日盤前紀錄**：取第 1 個交易日預測收盤價，並依其相對昨收決定 `漲`／`跌`／`平` 方向。
- **五日路徑檔**：依序取第 1 至第 5 個交易日預測收盤價（`method: "scenario"`）。
- **網頁 44 日圖表**：延伸至 44 個交易日，並於固定節點標記 B2、B3、S4 預設教學情境點。
- **歷史版本相容**：重跑時保留既有已發布紀錄，[shared/premarket.js](../shared/premarket.js) 與 [shared/five-day.js](../shared/five-day.js) 向下相容舊版 `workstation-ma20-v1`、`daily-*`、`taiex-v1-*` 與 `previous`／`ridge` 方法。

歷史統計對照研究（2023–2024 年訓練、2025 年驗證、2026 年截至 11 月 17 日驗收）保留於 [個股回測](../research/results.md)、[大盤回測](../research/taiex-results.md) 與 [五日回測](../research/five-day-results.md)。

## 發布資料格式

### 1. 每月單日紀錄（`data/daily-price-tracking/YYYY-MM.csv`）

保留 9 欄中文表頭與欄序（個股以元計、大盤以點計，缺值留白）：

| 欄位 | 說明 |
| --- | --- |
| `交易日` | 目標交易日（`YYYY-MM-DD`，台灣時間） |
| `股票代號` | 股票代號或 `TAIEX` |
| `預測收盤價` | 盤前預測之當日收盤價／點位 |
| `預測時間` | 實際記錄之台灣時間（`YYYY-MM-DD HH:mm:ss`，限 `06:00:00`–`08:59:59`） |
| `實際收盤價` | 盤後取得之正式收盤價／點位 |
| `收盤價取得時間` | 取得實際收盤之台灣時間 |
| `策略版本` | 模型版本（現行 `workstation-ma20-v2`） |
| `昨收` | 前一交易日收盤價／點位 |
| `預測方向` | `漲`、`跌` 或 `平` |

### 2. 五日路徑檔（`data/daily-price-tracking/paths/YYYY-MM-DD.json`）

- 自 `2026-11-26` 起按發布日存檔，最外層以股票代號或 `TAIEX` 為鍵；部分成功時僅出現已發布標的。
- 每筆包含 `trade_date`、`stock_id`、`generated_at`（台灣時間）、`history_through`（行情截至前一交易日）、`model_version`、`daily_model_version`、`direction` 及長度為 5 的 `targets` 陣列（每項含 `date`、`close`、`method`）。
- 同目錄 `latest.json` 以標的代號指向其最近發布日期。
