import { browser } from 'wxt/browser';
import type { Command, Failure, Payload, Request, Response, Result } from './protocol.ts';

export class JobFailure extends Error {
  constructor(readonly detail: Failure) {
    super(detail.message);
  }
}

interface PendingJob {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

export class WorkerClient {
  #worker: Worker | undefined;
  #pending = new Map<number, PendingJob>();
  #nextId = 0;

  #getWorker(): Worker {
    if (this.#worker) return this.#worker;
    // WXT serves page modules from localhost in dev, but workers must load from the extension origin.
    const worker = new Worker(browser.runtime.getURL('/workbench-worker.js'));
    this.#worker = worker;
    worker.onmessage = ({ data }: MessageEvent<Response>) => {
      this.#pending.get(data.id)?.resolve(data);
    };
    const fail = () => {
      if (this.#worker === worker) this.cancel(new JobFailure({ message: '处理线程中断，请重试。' }));
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    return worker;
  }

  async run<K extends Command>(type: K, payload: Payload<K>, timeout = 20000): Promise<Result<K>> {
    const worker = this.#getWorker();
    const id = ++this.#nextId;
    const response = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new JobFailure({ message: '操作未完成，已达到处理时间上限。' })), timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
      };
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      try {
        worker.postMessage({ ...payload, type, id } as Request);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    if ('error' in response) throw new JobFailure(response.error);
    return response.result as Result<K>;
  }

  cancel(error: Error = new DOMException('已取消。', 'AbortError')) {
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const job of this.#pending.values()) job.reject(error);
  }
}

export function wasCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
