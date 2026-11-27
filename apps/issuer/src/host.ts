import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { IssuerResult } from '@metaexam/contracts';

export class IssuerHost {
  private child?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  unlocked = false;
  lastActivity = Date.now();
  constructor(
    private readonly node: string,
    private readonly worker: string,
    private readonly home: string,
  ) {}
  private start() {
    if (this.child) return;
    const child = spawn(this.node, [this.worker, this.home], {
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    this.child = child;
    child.stderr.resume(); // Never forward worker diagnostics or credentials to renderer/logs.
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const result = JSON.parse(line) as IssuerResult & { id: number };
        const item = this.pending.get(result.id);
        if (!item) return;
        this.pending.delete(result.id);
        clearTimeout(item.timer);
        if (result.ok) item.resolve(result.value);
        else item.reject(new Error(result.code));
      } catch {
        this.lock();
      }
    });
    child.on('error', () => this.lock());
    child.on('exit', () => {
      if (this.child === child) this.lock();
    });
  }
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    this.start();
    if (method !== 'status') this.lastActivity = Date.now();
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.lock(), 120000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, args }) + '\n', (error) => {
        if (error) this.lock();
      });
    });
  }
  lock() {
    const child = this.child;
    this.child = undefined;
    this.unlocked = false;
    child?.kill();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('LOCKED'));
    }
    this.pending.clear();
  }
}
