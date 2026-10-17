import type { ComponentType } from "react";
import LightsOut from "./lights-out";

/**
 * Themes that come with a full-window effect, keyed by theme id. The effect is
 * portaled to <body> (see components/ThemeEffect.tsx), so it can draw behind
 * the app, above it, or both.
 */
export const THEME_EFFECTS: Record<string, ComponentType> = {
  "lights-out": LightsOut,
};
