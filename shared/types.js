/** @typedef {'漲'|'跌'|'平'} Direction */
/**
 * @typedef {object} ForecastRecord
 * @property {string} trade_date
 * @property {string} stock_id
 * @property {number|null} forecast_close
 * @property {string|null} forecast_at
 * @property {number|null} actual_close
 * @property {string|null} actual_recorded_at
 * @property {string|null} model_version
 * @property {number|null} previous_close
 * @property {Direction|null} forecast_direction
 */
/**
 * @typedef {object} DailyCandle
 * @property {string} date
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number|null} [volume]
 */
export {};
