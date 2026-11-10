import { useStore } from "../state/store";
import ChristmasScene from "../themes/christmas/scene";
import HalloweenScene from "../themes/halloween/scene";

/** The active theme's drawn scene at the foot of the sidebar, if it has one. */
export function ThemeScene() {
  const theme = useStore((s) => s.theme);
  const Scene = theme === "halloween" ? HalloweenScene : theme === "christmas" ? ChristmasScene : null;
  if (!Scene) return null;
  return (
    <div className="theme-scene">
      <Scene />
    </div>
  );
}
