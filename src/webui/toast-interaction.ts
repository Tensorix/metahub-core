/** Shared gesture thresholds, in CSS pixels and milliseconds. */
export function toastSwipeDismiss(dx: number, width: number, velocity: number): boolean {
  return Math.abs(dx) >= width * 0.3 || (Math.abs(dx) >= 24 && Math.abs(velocity) >= 0.5 && Math.sign(dx) === Math.sign(velocity));
}

/** Multiple interaction reasons share one remaining-time budget. */
export class ToastTimer {
  private reasons = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due = 0;
  private stopped = false;
  constructor(private left: number, private expire: () => void) { this.arm(); }
  private arm() {
    this.due = Date.now() + this.left;
    this.timer = setTimeout(() => { this.stop(); this.expire(); }, this.left);
  }
  pause(reason: string) {
    if (this.stopped || this.reasons.has(reason)) return;
    if (!this.reasons.size) {
      clearTimeout(this.timer);
      this.left = Math.max(0, this.due - Date.now());
    }
    this.reasons.add(reason);
  }
  resume(reason: string) {
    if (this.stopped || !this.reasons.delete(reason) || this.reasons.size) return;
    this.arm();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
