import type { Theme } from "./types";
import "./excel.css";

// Spreadsheet camouflage without sacrificing terminal input or selection.
// xterm already enables transparency: its transparent white background lets
// the CSS cell grid show through, over a solid white pane (never wallpaper).
// Row/column labels are decorative and do not pretend to be editable cells.
export const excel: Theme = {
  id: "excel",
  name: "Spreadsheet",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#f3f3f3",
    bg3: "#e3eee6",
    border: "#c8cdca",
    fg: "#202522",
    fgDim: "#526057",
    accent: "#217346",
    accentSoft: "rgba(33, 115, 70, 0.13)",
  },
  radius: {
    sm: "2px",
    md: "2px",
    lg: "1px",
  },
  sidebar: {
    bg: "#f3f3f3",
    border: "#c8cdca",
  },
  chrome: {
    topBar: "#217346",
    topBarBorder: "#185c37",
    activeTab: "#ffffff",
    activeRow: "#d5ebdd",
    paneGap: "4px",
    paneRadius: "0px",
    paneBorder: "#c8cdca",
    paneShadow: "none",
  },
  term: {
    background: "#ffffff00",
    foreground: "#161b18",
    cursor: "#217346",
    cursorAccent: "#ffffff",
    selectionBackground: "#c1dfcc",
    black: "#242424",
    red: "#ac2525",
    green: "#18722a",
    yellow: "#806000",
    blue: "#154ecc",
    magenta: "#842ba3",
    cyan: "#006879",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#bf2020",
    brightGreen: "#187521",
    brightYellow: "#896000",
    brightBlue: "#1859cf",
    brightMagenta: "#9637a6",
    brightCyan: "#006f82",
    brightWhite: "#777777",
  },
  vars: {
    // Fixed 64px text positions keep headings centered independently of the
    // platform's monospace font metrics. This is decoration, not terminal text.
    "--sheet-column-labels": `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="3328" height="20"><g fill="#425448" font-family="Arial,sans-serif" font-size="11" text-anchor="middle">${Array.from({ length: 52 }, (_, i) => `<text x="${i * 64 + 32}" y="14">${i < 26 ? "" : "A"}${String.fromCharCode(65 + i % 26)}</text>`).join("")}</g></svg>`,
    )}")`,
    "--pane-area-bg": "#e7e9e8",
    "--pane-focus-ring": "#217346",
    "--split-gutter-hover": "#217346",
  },
};
