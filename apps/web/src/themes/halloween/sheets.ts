// The built sprite sheets (scripts/halloween-sprites.mjs), bundled by Vite.
import backdropJson from "./art/sheets/backdrop.json";
import backdropPng from "./art/sheets/backdrop.png";
import bulbJson from "./art/sheets/bulb.json";
import bulbPng from "./art/sheets/bulb.png";
import bodyJson from "./art/sheets/pumpkin-body.json";
import bodyPng from "./art/sheets/pumpkin-body.png";
import flameJson from "./art/sheets/pumpkin-flame.json";
import flamePng from "./art/sheets/pumpkin-flame.png";
import lidsJson from "./art/sheets/pumpkin-lids.json";
import lidsPng from "./art/sheets/pumpkin-lids.png";
import pupilsJson from "./art/sheets/pumpkin-pupils.json";
import pupilsPng from "./art/sheets/pumpkin-pupils.png";
import wireJson from "./art/sheets/wire.json";
import wirePng from "./art/sheets/wire.png";
import type { Sheet } from "./player";

export type SheetWithImage = Sheet & { url: string };

const sheet = (json: unknown, url: string) => ({ ...(json as Sheet), url });

export const SHEETS = {
  backdrop: sheet(backdropJson, backdropPng),
  flame: sheet(flameJson, flamePng),
  pupils: sheet(pupilsJson, pupilsPng),
  lids: sheet(lidsJson, lidsPng),
  body: sheet(bodyJson, bodyPng),
  wire: sheet(wireJson, wirePng),
  bulb: sheet(bulbJson, bulbPng),
};

export type SheetName = keyof typeof SHEETS;

/** Scene size in art pixels: the light string (16 rows) over the night (48). */
export const SCENE_W = 60;
export const STRING_H = 16;
export const SCENE_H = STRING_H + 48;
/** One art pixel is 4 CSS px (PX-1 in art/README.md). */
export const CSS_PX = 4;
/** The eyes' midpoint in scene art pixels, used to aim the gaze. */
export const EYES = { x: 7 + 22.5, y: STRING_H + 7 + 14 };
/** Wire segments start 6 px left of the scene so three bulbs fit across it. */
export const WIRE_X = [-6, 18, 42];
