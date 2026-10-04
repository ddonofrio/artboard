export interface Activity { id?: string; kind: 'Tools' | 'Thinking' | 'Error'; text: string; tokens?: number; tokens_estimated?: boolean }
export function thinkingLabel(tokens?: number, estimated = false): string {
  const count = typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? `${estimated ? '~' : ''}${tokens}` : '?';
  return `Thinking (${count} tokens)`;
}
export function activityText(activity: Activity): string {
  return activity.kind === 'Thinking' ? `Thinking${activity.text ? `: ${activity.text}` : ''}` : activity.text;
}
export type Schedule = (callback: () => void, delay: number) => () => void;
const scheduleTimer: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** Display events in order, keeping each visible for at least one second. */
export class TimedLog {
  private queue: Activity[] = [];
  private holding = false;
  private current?: Activity;
  private seen = new Set<string>();
  private cancel?: () => void;
  constructor(private show: (activity: Activity) => void, private schedule: Schedule = scheduleTimer) {}
  enqueue(activity: Activity): void {
    if (activity.id && this.current?.id === activity.id) {
      this.current = activity; this.show(activity); return;
    }
    const index = activity.id ? this.queue.findIndex(item => item.id === activity.id) : -1;
    if (index >= 0) { this.queue[index] = activity; return; }
    if (activity.id) {
      if (this.seen.has(activity.id)) return;
      this.seen.add(activity.id);
    }
    this.queue.push(activity);
    if (!this.holding) this.advance();
  }
  reset(): void { this.cancel?.(); this.cancel = undefined; this.queue = []; this.current = undefined; this.seen.clear(); this.holding = false; }
  private advance(): void {
    const next = this.queue.shift();
    if (!next) { this.holding = false; this.cancel = undefined; return; }
    this.holding = true;
    this.current = next;
    this.show(next);
    this.cancel = this.schedule(() => this.advance(), 1000);
  }
}
