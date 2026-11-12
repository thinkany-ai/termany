import { useStore } from "../state/store";
import ChristmasBackdrop from "../themes/christmas/backdrop";
import HalloweenScene from "../themes/halloween/scene";

/** The active theme's drawn scene at the foot of the sidebar, if it has one. */
export function ThemeScene() {
  const theme = useStore((s) => s.theme);
  if (theme !== "halloween") return null;
  return (
    <div className="theme-scene">
      <HalloweenScene />
    </div>
  );
}

/** The active theme's window-wide artwork and overlays, if it has any. */
export function ThemeBackdrop() {
  const theme = useStore((s) => s.theme);
  return theme === "christmas" ? <ChristmasBackdrop /> : null;
}
