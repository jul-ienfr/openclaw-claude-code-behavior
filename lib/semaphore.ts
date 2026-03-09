export class Semaphore {
  private permits: number;
  private readonly max: number;
  private queue: Array<(release: () => void) => void> = [];

  constructor(max: number) {
    this.permits = max;
    this.max = max;
  }

  get available(): number {
    return this.permits;
  }

  get running(): number {
    return this.max - this.permits;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve(this.createRelease());
      } else {
        this.queue.push(resolve);
      }
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Transfer permit directly to next waiter
        next(this.createRelease());
      } else {
        this.permits++;
      }
    };
  }
}
