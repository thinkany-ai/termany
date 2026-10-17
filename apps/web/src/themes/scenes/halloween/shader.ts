import { H, LAMP, MOON, W } from "./art";

// GLSL ES 3.00 (WebGL2). One full-screen triangle; the fragment shader paints
// the whole scene per pixel. Coordinates are scene units with y down, the
// same space the SVG artwork is drawn in.

export const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const f = (n: number) => n.toFixed(2);

export const FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;        // canvas, px
uniform float uScale;     // px per scene unit
uniform vec2 uOrigin;     // scene's top-left corner, px from the canvas top-left
uniform float uTime;      // seconds of ambient time
uniform float uFlicker;   // candle brightness, ~0.75..1.15
uniform float uWindows;   // house windows brightness

uniform sampler2D uRidge;
uniform sampler2D uFar;
uniform sampler2D uFarEmit;
uniform sampler2D uMid;
uniform sampler2D uNear;
uniform sampler2D uOwl;
uniform sampler2D uPumpkin;
uniform sampler2D uFaceA;
uniform sampler2D uFaceB;
uniform sampler2D uGhost;
uniform sampler2D uBat;
uniform sampler2D uWitch;

uniform vec4 uOwlRect;
uniform vec2 uOwlPivot;
uniform float uOwlAngle;
uniform vec4 uPumpkinRect;
uniform vec2 uSquash;
uniform float uFace;
uniform vec4 uGhostRect;
uniform float uGhostAlpha;
uniform vec4 uWitchRect;
uniform float uWitchAlpha;
uniform vec4 uBats[3];    // centre x, centre y, scale, frame (0 or 1)
uniform vec2 uBatSize;

const vec2 SIZE = vec2(${f(W)}, ${f(H)});
const vec2 MOON = vec2(${f(MOON.x)}, ${f(MOON.y)});
const float MOON_R = ${f(MOON.r)};
const vec2 LAMP = vec2(${f(LAMP.x)}, ${f(LAMP.y)});

// --- noise ------------------------------------------------------------------

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = r * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

// --- helpers ----------------------------------------------------------------

bool inside(vec2 uv) {
  return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
}
/** Sample a sprite, transparent outside its box. Always samples, so the
 *  texture's mip level comes from smooth derivatives, never from a branch. */
vec4 sprite(sampler2D t, vec2 uv) {
  vec4 c = texture(t, uv);
  return inside(uv) ? c : vec4(0.0);
}
vec3 over(vec3 dst, vec4 src) {
  return dst * (1.0 - src.a) + src.rgb;
}
/** A glow around the bright parts of a texture: its blurrier mip levels,
 *  summed. Low levels only, so a glow stays near what casts it. */
vec3 bloomAt(sampler2D t, vec2 uv) {
  return textureLod(t, uv, 1.5).rgb * 0.22 + textureLod(t, uv, 2.5).rgb * 0.26
       + textureLod(t, uv, 3.5).rgb * 0.3 + textureLod(t, uv, 4.5).rgb * 0.18;
}

// --- sky --------------------------------------------------------------------

vec3 stars(vec2 p) {
  vec3 c = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float cell = k == 0 ? 7.0 : 15.0;
    float keep = k == 0 ? 0.74 : 0.62;
    vec2 g = floor(p / cell);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 id = g + vec2(float(i), float(j));
        float h = hash12(id + float(k) * 31.7);
        if (h < keep) continue;
        vec2 sp = (id + hash22(id + float(k) * 7.3)) * cell;
        float d = length(p - sp) * uScale;
        float r = (k == 0 ? 0.35 : 0.7) * uScale + 0.35;
        float tw = 0.55 + 0.45 * sin(uTime * (0.8 + 2.4 * h) + h * 40.0);
        float b = exp(-d * d / (r * r)) * tw * (h - keep) / (1.0 - keep) * (k == 0 ? 0.7 : 1.3);
        // The brightest few get a soft cross flare.
        if (k == 1 && h > 0.93) {
          vec2 dv = abs(p - sp) * uScale;
          b += (exp(-dv.x * 0.9) * exp(-dv.y * dv.y * 0.6) + exp(-dv.y * 0.9) * exp(-dv.x * dv.x * 0.6)) * 0.35 * tw;
        }
        c += mix(vec3(1.0, 0.9, 0.8), vec3(0.8, 0.86, 1.0), fract(h * 13.0)) * b;
      }
    }
  }
  return c;
}

vec3 skyColor(vec2 p) {
  float h = p.y / SIZE.y;
  vec3 c = mix(vec3(0.012, 0.008, 0.03), vec3(0.05, 0.028, 0.1), smoothstep(0.0, 0.42, h));
  c = mix(c, vec3(0.16, 0.06, 0.19), smoothstep(0.4, 0.7, h));
  // A slow violet nebula.
  float n = fbm(p * 0.016 + vec2(uTime * 0.0025, 0.0));
  c += vec3(0.2, 0.09, 0.32) * pow(n, 3.0) * 0.45 * (1.0 - h);
  // A magenta glow along the horizon.
  c += vec3(0.30, 0.08, 0.22) * exp(-pow((p.y - 170.0) / 36.0, 2.0)) * 0.5;
  // Stars fade out near the moon and the horizon.
  float dm = length(p - MOON);
  c += stars(p) * smoothstep(MOON_R + 4.0, MOON_R + 34.0, dm) * smoothstep(175.0, 110.0, p.y);
  return c;
}

vec3 moonSurface(vec2 q) {
  float z = sqrt(max(0.0, 1.0 - dot(q, q)));
  vec2 s = q / (0.6 + 0.4 * z);
  float m = fbm(s * 2.2 + vec2(3.1, 1.7));
  float maria = smoothstep(0.46, 0.66, m);
  vec3 col = mix(vec3(1.0, 0.95, 0.86), vec3(0.76, 0.64, 0.56), maria * 0.8);
  col *= 0.86 + 0.2 * fbm(s * 9.0 + 5.0);
  vec2 g = s * 4.2;
  vec2 id = floor(g);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cid = id + vec2(float(i), float(j));
      if (hash12(cid + 9.1) < 0.5) continue;
      vec2 cp = cid + hash22(cid);
      float r = 0.16 + 0.3 * hash12(cid + 3.3);
      vec2 dv = g - cp;
      float d = length(dv) / r;
      if (d < 1.2) {
        col *= 1.0 - 0.14 * smoothstep(1.0, 0.65, d);
        float rim = smoothstep(0.72, 1.0, d) * smoothstep(1.2, 1.0, d);
        col *= 1.0 + 0.3 * rim * dot(normalize(dv + 1e-4), vec2(0.6, 0.8));
      }
    }
  }
  return col * (0.48 + 0.6 * pow(z, 0.45));
}

vec4 clouds(vec2 p) {
  vec2 q = vec2(p.x * 0.012 - uTime * 0.0075, p.y * 0.035);
  float n = fbm(q * 2.2 + vec2(0.0, 3.0) + 0.5 * fbm(q * 3.0 + 8.0));
  float band = exp(-pow((p.y - 102.0) / 12.0, 2.0)) + 0.8 * exp(-pow((p.y - 46.0) / 9.0, 2.0));
  float d = smoothstep(0.44, 0.82, n) * band;
  float lit = exp(-length(p - MOON) / 50.0);
  vec3 c = mix(vec3(0.09, 0.06, 0.15), vec3(0.75, 0.62, 0.86), lit * (1.0 - smoothstep(0.25, 0.85, d)));
  float a = d * 0.72;
  return vec4(c * a, a);
}

// --- light and fog ----------------------------------------------------------

/** The candle's light at p: warm, falling off, stretched sideways. */
float lamp(vec2 p) {
  vec2 d = (p - LAMP) * vec2(1.0, 1.35);
  return exp(-length(d) / 28.0) * uFlicker;
}
/** Brighten a layer near the candle, and tint it warm. */
vec4 lit(vec4 layer, vec2 p, float k) {
  float l = lamp(p) * k;
  layer.rgb *= 1.0 + vec3(3.2, 1.9, 1.1) * l;
  layer.rgb += vec3(0.5, 0.2, 0.05) * l * layer.a * 0.35;
  return layer;
}
vec3 fogLight(vec2 p) {
  float dm = length(p - MOON);
  vec3 moon = vec3(0.6, 0.56, 0.82) * (0.3 + 1.3 * exp(-dm / 90.0));
  vec3 warm = vec3(1.0, 0.48, 0.14) * 1.5 * lamp(p);
  return moon + warm;
}
float fogBand(vec2 p, float top, float bottom, float scale, float speed, float seed) {
  float h = smoothstep(top, bottom, p.y);
  if (h <= 0.0) return 0.0;
  vec2 q = p * scale * vec2(0.55, 1.5) + vec2(uTime * speed, 0.0) + seed;
  vec2 w = vec2(fbm(q + 4.0 + uTime * speed * 0.5), fbm(q + 9.0));
  float n = fbm(q + 1.2 * w);
  return h * smoothstep(0.34, 0.78, n);
}
vec3 fog(vec3 col, vec2 p, float top, float bottom, float scale, float speed, float seed, float amount) {
  float d = fogBand(p, top, bottom, scale, speed, seed) * amount;
  return mix(col, fogLight(p) * 0.55, d);
}

// --- light shafts -----------------------------------------------------------

vec3 rays(vec2 p) {
  vec2 toMoon = MOON - p;
  float dist = length(toMoon);
  float jitter = hash12(p * uScale + fract(uTime * 0.37) * 91.0);
  float acc = 0.0;
  for (int i = 0; i < 18; i++) {
    float t = (float(i) + jitter) / 18.0;
    vec2 s = p + toMoon * t * 0.95;
    vec2 suv = s / SIZE;
    float occ = max(textureLod(uFar, suv, 2.0).a, textureLod(uMid, suv, 2.0).a);
    float src = exp(-max(length(s - MOON) - MOON_R * 0.5, 0.0) / 20.0);
    acc += (1.0 - occ) * src;
  }
  acc /= 18.0;
  return vec3(1.0, 0.84, 0.64) * pow(acc, 2.0) * 0.42 * smoothstep(260.0, 50.0, dist);
}

// --- particles --------------------------------------------------------------

vec3 particles(vec2 p) {
  vec3 c = vec3(0.0);
  float core = 0.8 * uScale;
  // Fireflies over the graveyard.
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 base = vec2(14.0 + fi * 25.0 + 6.0 * sin(fi * 3.1), 194.0 + 20.0 * hash12(vec2(fi, 2.0)));
    vec2 pos = base + vec2(sin(uTime * 0.31 + fi * 1.7) * 10.0 + sin(uTime * 0.13 + fi) * 6.0,
                           cos(uTime * 0.27 + fi * 2.3) * 7.0);
    float blink = smoothstep(0.1, 1.0, sin(uTime * (0.5 + 0.4 * hash12(vec2(fi, 5.0))) + fi * 2.1));
    float d = length(p - pos) * uScale;
    c += vec3(0.72, 1.0, 0.5) * (exp(-d * d / (core * core)) * 1.2 + exp(-d / (5.0 * uScale)) * 0.16) * blink;
  }
  // Embers rising off the candle; many more while it cackles.
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float h = hash12(vec2(fi, 9.0));
    if (fi > 5.0 + uFace * 7.0) break;
    float life = fract(uTime * (0.1 + 0.08 * h + uFace * 0.5) + h);
    vec2 pos = LAMP + vec2((h - 0.5) * 18.0 + sin(life * 9.0 + fi) * 4.0, -12.0 - life * 64.0);
    float fade = smoothstep(0.0, 0.08, life) * (1.0 - life);
    float d = length(p - pos) * uScale;
    c += vec3(1.0, 0.58, 0.18) * (exp(-d * d / (core * core * 0.6)) * 1.4 + exp(-d / (3.0 * uScale)) * 0.12) * fade;
  }
  return c;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// --- the scene --------------------------------------------------------------

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = (px - uOrigin) / uScale;
  vec2 uv = p / SIZE;

  vec3 col = skyColor(p);

  // The moon: two halos, then the disc.
  float dm = length(p - MOON);
  float edge = max(dm - MOON_R, 0.0);
  col += vec3(1.0, 0.8, 0.58) * (0.4 * exp(-edge / 5.0) + 0.17 * exp(-edge / 22.0) + 0.05 * exp(-edge / 70.0));
  float aa = 1.2 / uScale;
  col = mix(col, moonSurface((p - MOON) / MOON_R), 1.0 - smoothstep(MOON_R - aa, MOON_R + aa, dm));

  // The witch and the bats, then clouds that may pass in front of them.
  col = over(col, sprite(uWitch, (p - uWitchRect.xy) / uWitchRect.zw) * uWitchAlpha);
  for (int i = 0; i < 3; i++) {
    vec4 b = uBats[i];
    vec2 size = uBatSize * b.z;
    vec2 buv = (p - (b.xy - size * 0.5)) / size;
    vec4 s = texture(uBat, vec2((clamp(buv.x, 0.0, 1.0) + b.w) * 0.5, buv.y));
    col = over(col, inside(buv) ? s : vec4(0.0));
  }
  col = over(col, clouds(p));

  // The ridge, far away: hazed toward the horizon's colour.
  vec4 ridge = texture(uRidge, uv);
  ridge.rgb = mix(ridge.rgb, vec3(0.2, 0.1, 0.26) * ridge.a, 0.5);
  col = over(col, ridge);

  // Far: a thin haze, the ridge and the house with its windows.
  col = fog(col, p, 136.0, 178.0, 0.03, 0.03, 1.0, 0.32);
  col = over(col, lit(texture(uFar, uv), p, 0.3));
  col += texture(uFarEmit, uv).rgb * uWindows;

  // The valley fills with fog.
  col = fog(col, p, 164.0, 204.0, 0.04, 0.045, 7.0, 0.78);

  // Middle: hill, tree, fence, owl.
  col = over(col, lit(texture(uMid, uv), p, 0.7));
  {
    vec2 d = p - uOwlPivot;
    float c = cos(-uOwlAngle);
    float s = sin(-uOwlAngle);
    d = mat2(c, s, -s, c) * d;
    col = over(col, sprite(uOwl, (d + uOwlPivot - uOwlRect.xy) / uOwlRect.zw));
  }

  // Light wrap: the moon's glow spills over the edges of what stands in
  // front of it, as it does through a lens.
  col += vec3(1.0, 0.86, 0.66) * (0.16 * exp(-edge / 4.0) + 0.06 * exp(-edge / 14.0));

  // The ghost rises behind the stones: drawn before them, after the hill.
  if (uGhostAlpha > 0.0) {
    vec2 gc = uGhostRect.xy + uGhostRect.zw * vec2(0.5, 0.52);
    vec2 gd = (p - gc) / uGhostRect.zw;
    col += vec3(0.72, 0.66, 1.0) * exp(-dot(gd, gd) * 5.0) * 0.32 * uGhostAlpha;
    vec2 guv = (p - uGhostRect.xy) / uGhostRect.zw;
    guv.x += sin(guv.y * 11.0 - uTime * 7.0) * 0.03 * smoothstep(0.5, 0.95, guv.y);
    col = over(col, sprite(uGhost, guv) * uGhostAlpha);
  }

  col = fog(col, p, 208.0, 242.0, 0.05, 0.055, 13.0, 0.4);

  // Near: ground, stones, the small pumpkins.
  col = over(col, lit(texture(uNear, uv), p, 1.0));

  // The jack-o'-lantern, squashing about its base when it laughs.
  vec2 puv = (p - uPumpkinRect.xy) / uPumpkinRect.zw;
  vec2 base = vec2(0.5, 0.78);
  vec2 suv = (puv - base) / uSquash + base;
  // Its skin is lit only by the moon and a little spill from inside: dark.
  vec4 skin = sprite(uPumpkin, suv);
  skin.rgb *= vec3(0.62, 0.46, 0.38) * (0.85 + 0.15 * uFlicker);
  col = over(col, skin);
  vec4 face = mix(sprite(uFaceA, suv), sprite(uFaceB, suv), uFace);
  face.rgb *= 0.8 + 0.5 * uFlicker;
  col = over(col, face);

  // A low veil of fog in front of everything.
  col = fog(col, p, 244.0, 272.0, 0.06, 0.07, 21.0, 0.2);

  col += rays(p);
  col += bloomAt(uFarEmit, uv) * uWindows * 0.75;
  if (inside(suv)) {
    // Fade to nothing at the sprite's edges, so its box never shows.
    float e = smoothstep(0.0, 0.16, min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y)));
    vec3 glow = mix(bloomAt(uFaceA, suv), bloomAt(uFaceB, suv), uFace);
    col += glow * (0.45 + 0.45 * uFlicker) * e;
  }
  col += particles(p);

  col = aces(col * 1.05);
  vec2 v = uv - vec2(0.55, 0.45);
  col *= 1.0 - 0.45 * smoothstep(0.3, 0.9, length(v * vec2(1.1, 0.95)));
  col += (hash12(px + fract(uTime * 7.0) * 113.0) - 0.5) * 0.022;
  outColor = vec4(col, 1.0);
}`;
