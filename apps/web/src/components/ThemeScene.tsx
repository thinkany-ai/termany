import { useStore } from "../state/store";
import { THEME_SCENES } from "../themes/scenes";

/** The active theme's sidebar scene, if it has one. */
export function ThemeScene() {
  const theme = useStore((s) => s.theme);
  const Scene = THEME_SCENES[theme];
  return Scene ? (
    <div className="theme-scene">
      <Scene />
    </div>
  ) : null;
}
