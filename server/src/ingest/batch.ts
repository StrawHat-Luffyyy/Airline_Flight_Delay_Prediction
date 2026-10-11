/**
 * Groups an async source into arrays of at most `size`. Holds one batch in memory at a time;
 * the consumer awaits each batch before the next is read, so backpressure reaches the source.
 */
export async function* inBatches<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
