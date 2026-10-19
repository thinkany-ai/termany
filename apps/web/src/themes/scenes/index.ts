import type { ComponentType } from "react";
import HalloweenScene from "./halloween";

/**
 * Themes whose look includes a drawn, interactive scene, keyed by theme id.
 * The scene fills the foot of the sidebar (see components/ThemeScene.tsx).
 * Add one by writing ./<id>/index.tsx (plus its stylesheet) and listing it
 * here; scripts/theme-previews.mjs finds it by the same directory name.
 */
export const THEME_SCENES: Record<string, ComponentType<{ still?: boolean }>> = {
  halloween: HalloweenScene,
};
