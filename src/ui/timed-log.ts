export interface Activity { kind: 'Tools' | 'Thinking' | 'Error'; text: string }
export type Schedule = (callback: () => void, delay: number) => () => void;
const scheduleTimer: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** Display events in order, keeping each visible for at least one second. */
export class TimedLog {
  private queue: Activity[] = [];
  private holding = false;
  private cancel?: () => void;
  constructor(private show: (activity: Activity) => void, private schedule: Schedule = scheduleTimer) {}
  enqueue(activity: Activity): void {
    this.queue.push(activity);
    if (!this.holding) this.advance();
  }
  reset(): void { this.cancel?.(); this.cancel = undefined; this.queue = []; this.holding = false; }
  private advance(): void {
    const next = this.queue.shift();
    if (!next) { this.holding = false; this.cancel = undefined; return; }
    this.holding = true;
    this.show(next);
    this.cancel = this.schedule(() => this.advance(), 1000);
  }
}
