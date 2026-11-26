import { spawn } from "node:child_process";

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
	const limit = Math.max(1, Math.floor(concurrency));
	let active = 0;
	const queue: Array<() => void> = [];

	const next = (): void => {
		active -= 1;
		const resume = queue.shift();
		if (resume) resume();
	};

	return <T>(fn: () => Promise<T>): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const run = (): void => {
				active += 1;
				Promise.resolve()
					.then(fn)
					.then(resolve, reject)
					.finally(next);
			};
			if (active < limit) {
				run();
			} else {
				queue.push(run);
			}
		});
	};
}

const IN_FLIGHT_SYMBOL = Symbol.for("uniroute.singleflight");
const g = globalThis as Record<symbol, Map<string, Promise<unknown>>>;
const inFlightMap: Map<string, Promise<unknown>> =
	g[IN_FLIGHT_SYMBOL] ?? (g[IN_FLIGHT_SYMBOL] = new Map());

export function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = inFlightMap.get(key) as Promise<T> | undefined;
	if (existing) return existing;

	const promise = Promise.resolve()
		.then(fn)
		.finally(() => {
			if (inFlightMap.get(key) === promise) {
				inFlightMap.delete(key);
			}
		});
	inFlightMap.set(key, promise);
	return promise;
}

export class TtlCache<K, V> {
	private readonly store = new Map<K, { value: V; expiresAt: number }>();
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(maxSize: number, ttlMs: number) {
		this.maxSize = Math.max(1, maxSize);
		this.ttlMs = Math.max(1, ttlMs);
	}

	get(key: K): V | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return undefined;
		}
		this.store.delete(key);
		this.store.set(key, entry);
		return entry.value;
	}

	set(key: K, value: V): void {
		if (this.store.has(key)) {
			this.store.delete(key);
		} else if (this.store.size >= this.maxSize) {
			const oldest = this.store.keys().next().value;
			if (oldest !== undefined) this.store.delete(oldest);
		}
		this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
	}

	delete(key: K): boolean {
		return this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	get size(): number {
		return this.store.size;
	}
}

export type EphemeralJobOptions<TInput, TOutput> = {
	timeoutMs?: number;
	fallback?: (input: TInput) => Promise<TOutput> | TOutput;
};

export async function runEphemeralJob<TInput, TOutput>(
	script: string,
	input: TInput,
	opts: EphemeralJobOptions<TInput, TOutput> = {},
): Promise<TOutput> {
	const timeoutMs = opts.timeoutMs ?? 30_000;

	try {
		return await new Promise<TOutput>((resolve, reject) => {
			let settled = false;
			const child = spawn(process.execPath, ["-e", script], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				env: { ...process.env, BUN_BE_BUN: "1" },
			});

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let totalOut = 0;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
				reject(new Error(`ephemeral job timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			child.stdout.on("data", (chunk: Buffer) => {
				totalOut += chunk.length;
				if (totalOut <= 8 * 1024 * 1024) {
					stdoutChunks.push(chunk);
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderrChunks.length < 32) stderrChunks.push(chunk);
			});

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				const outText = Buffer.concat(stdoutChunks).toString("utf8").trim();
				const errText = Buffer.concat(stderrChunks).toString("utf8").trim();
				if (code !== 0) {
					reject(new Error(errText || outText || `ephemeral job exited ${code}`));
					return;
				}
				try {
					resolve(JSON.parse(outText) as TOutput);
				} catch {
					reject(new Error(errText || "invalid ephemeral job output"));
				}
			});

			child.stdin.end(JSON.stringify(input));
		});
	} catch (err) {
		if (opts.fallback) {
			return await opts.fallback(input);
		}
		throw err;
	}
}
