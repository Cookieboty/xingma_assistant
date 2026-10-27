/** Bounded concurrency over an array (not unbounded Promise.all). */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  if (!n) return results;
  const limit = Math.max(1, Math.min(concurrency | 0 || 1, n));
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}
