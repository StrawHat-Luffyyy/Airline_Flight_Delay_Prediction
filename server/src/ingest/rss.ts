/** Tracks peak resident set size while a long job runs (evidence for the memory limit). */
export class RssMonitor {
  private peakBytes = process.memoryUsage().rss;
  private readonly timer = setInterval(() => this.sample(), 1_000);

  constructor() {
    this.timer.unref();
  }

  sample(): void {
    this.peakBytes = Math.max(this.peakBytes, process.memoryUsage().rss);
  }

  /** Stops sampling and returns the peak in MB. */
  stop(): number {
    clearInterval(this.timer);
    this.sample();
    return Math.round(this.peakBytes / 1024 / 1024);
  }
}
