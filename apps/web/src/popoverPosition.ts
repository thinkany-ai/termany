export interface PopoverAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Keep a header popup on screen, preferring below unless above has more room. */
export function popoverPosition(
  anchor: PopoverAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "left" | "right" = "right",
) {
  const margin = 8;
  const gap = 4;
  const below = Math.max(0, viewport.height - margin - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - margin);
  const flip = size.height > below && above > below;
  const maxHeight = Math.min(Math.max(0, viewport.height - margin * 2), flip ? above : below);
  const left = Math.max(margin, Math.min(
    align === "left" ? anchor.left : anchor.right - size.width,
    viewport.width - margin - size.width,
  ));
  const top = Math.max(margin, flip ? anchor.top - gap - Math.min(size.height, maxHeight) : anchor.bottom + gap);
  return { left, top, maxHeight };
}
