// Smart Group Tab — retry backoff.
//
// A pure function on purpose. A backoff tested by watching it — sleeping through
// real intervals and asserting something eventually happened — is slow, flaky,
// and usually proves only that one retry occurred. Take the attempt count and
// return a delay, and the whole curve is a unit test.
//
// Nothing here reads a clock or a randomness source it was not handed.

export const DEFAULTS = {
  // Long enough that a kitchen display rebooting is not hammered, short enough
  // that a transient blip does not delay dinner.
  baseMs: 2_000,
  // Past roughly a minute, waiting longer stops buying anything: whatever is
  // broken is broken, and the attempt ceiling is what ends it.
  capMs: 60_000,
  // Several rows failing against one dead destination would otherwise retry in
  // lockstep forever, arriving as a burst every time.
  jitterRatio: 0.2,
  // Reached in a couple of minutes with the curve above. The point is not to
  // exhaust every hope of delivery; it is to stop pretending and tell a human
  // that food which was paid for is not being cooked.
  maxAttempts: 8,
}

/**
 * Delay before attempt number `attempts + 1`, in milliseconds.
 *
 * @param attempts  failures so far (0 means the first attempt has just failed)
 * @param random    () => [0,1). Injected so the curve is deterministic in tests.
 */
export function backoffMs(attempts, { baseMs, capMs, jitterRatio } = DEFAULTS, random = Math.random) {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`backoffMs: attempts must be a non-negative integer, got ${attempts}`)
  }

  // Exponent is clamped before the shift: 2 ** 1024 is Infinity, and Infinity
  // through Math.min would still be Infinity on a platform where capMs is not.
  const growth = baseMs * 2 ** Math.min(attempts, 30)
  const flat = Math.min(growth, capMs)

  // Jitter only ever shortens. Lengthening could push a retry past the cap, and
  // the cap is the one property this function promises.
  const jitter = flat * jitterRatio * random()
  return Math.round(flat - jitter)
}
