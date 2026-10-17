import { createPortal } from "react-dom";
import { useStore } from "../state/store";
import { THEME_EFFECTS } from "../themes/effects";

/** The active theme's full-window effect, if it has one. */
export function ThemeEffect() {
  const theme = useStore((s) => s.theme);
  const Effect = THEME_EFFECTS[theme];
  return Effect ? createPortal(<Effect />, document.body) : null;
}
