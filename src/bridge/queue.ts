/**
 * queue.ts — примитивы конкуренции моста (порт asyncio.Queue + asyncio.Lock).
 *
 * Node — однопоточный event-loop, поэтому «воркеры» это просто конкурентные
 * async-циклы. AsyncQueue даёт backpressure (QueueFull) + быстрый webhook-200;
 * Mutex сериализует ход внутри одного chat_id (single-flight, [ADR-0007]).
 */

/** Бросается putNowait, когда буфер переполнен (как asyncio.QueueFull). */
export class QueueFull extends Error {
	constructor() {
		super('queue full');
		this.name = 'QueueFull';
	}
}

/**
 * Очередь с ограниченным буфером. putNowait не блокирует (бросает QueueFull);
 * get() ждёт элемент. close() будит всех ожидающих значением null (для shutdown).
 */
export class AsyncQueue<T> {
	private items: T[] = [];
	private waiters: ((v: T | null) => void)[] = [];
	private closed = false;

	constructor(private readonly maxSize: number) {}

	get size(): number {
		return this.items.length;
	}

	/** Положить без блокировки. Если есть ожидающий get — отдаём напрямую. */
	putNowait(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(item);
			return;
		}
		if (this.items.length >= this.maxSize) throw new QueueFull();
		this.items.push(item);
	}

	/** Взять элемент; ждёт, если пусто. Возвращает null, если очередь закрыта. */
	get(): Promise<T | null> {
		const item = this.items.shift();
		if (item !== undefined) return Promise.resolve(item);
		if (this.closed) return Promise.resolve(null);
		return new Promise<T | null>((resolve) => this.waiters.push(resolve));
	}

	/** Закрыть: будит все ожидающие get() значением null. */
	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(null);
	}
}

/**
 * Mutex single-flight: сериализует async-операции в порядке вызова. Аналог
 * asyncio.Lock + `async with`. Использование: `await mutex.run(async () => {...})`.
 */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((r) => {
			release = r;
		});
		return prev.then(fn).finally(release);
	}
}
