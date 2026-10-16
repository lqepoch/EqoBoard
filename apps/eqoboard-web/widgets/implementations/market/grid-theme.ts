import { themeQuartz } from "ag-grid-community";

/**
 * Dark AG Grid theme that mirrors the native dark surface tokens in styles/tokens.css.
 * Literal values keep the grid legible without depending on the page theme toggle.
 */
export const MARKET_GRID_THEME = themeQuartz.withParams({
  backgroundColor: "#0c121a",
  foregroundColor: "#e6edf5",
  accentColor: "#5aa2ff",
  headerTextColor: "#95a4b5",
});
