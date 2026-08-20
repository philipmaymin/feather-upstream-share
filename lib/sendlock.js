// Keyed async lock (U1): serialize async functions that share a key, while
// functions with different keys run concurrently. Used to serialize the tmux
// send sequence per session so two senders can't interleave bytes into one pane.
//
// The chain advances via .then(fn, fn) so it runs the next function regardless
// of whether the previous one resolved or rejected — a failing send can never
// deadlock later sends for the same key.
export function createKeyedLock() {
  const tails = new Map(); // key -> Promise (tail of the chain)
  return function lock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}
