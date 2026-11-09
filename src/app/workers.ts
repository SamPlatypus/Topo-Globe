/** A small pool of tile/calculation workers with request ids and cancellation. */
export interface WorkerReply { id: number; ok: boolean; result?: unknown; error?: string }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; worker: Worker };

export class WorkerPool {
  readonly workers: Worker[] = [];
  private seq = 1;
  private pending = new Map<number, Pending>();
  private rr = 0;

  constructor(count: number, factory: () => Worker) {
    for (let i = 0; i < count; i++) {
      const w = factory();
      w.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.result);
        else p.reject(new Error(ev.data.error));
      };
      w.onerror = (e) => console.error('worker error', e.message);
      this.workers.push(w);
    }
  }

  private send<T>(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, worker: w });
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this.pending.has(id)) w.postMessage({ id: this.seq++, type: 'cancel', target: id });
        });
      }
      w.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Round-robin tile request. */
  tile<T>(msg: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const w = this.workers[this.rr++ % this.workers.length];
    return this.send<T>(w, msg, [], signal);
  }

  /** Query on the first worker (profiles, routing, point info). */
  query<T>(msg: Record<string, unknown>): Promise<T> {
    return this.send<T>(this.workers[0], msg);
  }

  /** Send to every worker (region load/unload). */
  all<T>(make: (i: number) => { msg: Record<string, unknown>; transfer?: Transferable[] }): Promise<T[]> {
    return Promise.all(this.workers.map((w, i) => {
      const { msg, transfer } = make(i);
      return this.send<T>(w, msg, transfer ?? []);
    }));
  }
}
