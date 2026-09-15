/** A page drag must belong to one uninterrupted primary-button press. */
export class PageDragGesture<T> {
  private press: { pointerId: number; x: number; y: number; data: T; active: boolean } | null = null;
  private suppressClick = false;

  start(pointerId: number, x: number, y: number, data: T) {
    // A fresh press must never inherit click suppression from an earlier drag.
    this.suppressClick = false;
    this.press = { pointerId, x, y, data, active: false };
  }

  move(event: { pointerId: number; buttons: number; clientX: number; clientY: number }) {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return "ignore";
    if (!(event.buttons & 1)) {
      this.cancel();
      return "cancel";
    }
    if (!press.active) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) return "ignore";
      press.active = true;
      return "start";
    }
    return "move";
  }

  get data(): T | undefined { return this.press?.data; }

  release(pointerId: number): T | undefined {
    if (!this.press || pointerId !== this.press.pointerId) return undefined;
    const { active, data } = this.press;
    this.press = null;
    this.suppressClick = active;
    return active ? data : undefined;
  }

  cancel(pointerId?: number): boolean {
    if (pointerId !== undefined && this.press?.pointerId !== pointerId) return false;
    this.press = null;
    this.suppressClick = false;
    return true;
  }

  consumeClick(): boolean {
    const suppressed = this.suppressClick;
    this.suppressClick = false;
    return suppressed;
  }
}
