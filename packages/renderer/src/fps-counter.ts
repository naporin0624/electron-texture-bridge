/** Simple FPS counter that reports once per second */
export class FpsCounter {
  private count = 0;
  private lastTime = Date.now();

  /** Reset the counter, discarding any accumulated frames and time. */
  reset(): void {
    this.count = 0;
    this.lastTime = Date.now();
  }

  /** Call on every frame. Returns FPS when 1 second has elapsed, otherwise null. */
  tick(): number | null {
    this.count++;
    const now = Date.now();
    const elapsed = now - this.lastTime;
    if (elapsed < 1000) return null;

    const fps = (this.count * 1000) / elapsed;
    this.count = 0;
    this.lastTime = now;
    return fps;
  }
}
