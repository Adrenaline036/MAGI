// Model budgets, declared once.
//
// The MCP tool description and the code that enforces the limit must agree: they once did not,
// and the description promised a 420 s default while the bridge enforced 600 s. A caller that
// sizes its expectations on the description is killed mid-review and reads the kill as a
// reviewer failure. The description text is built from these numbers, and the same helpers do
// the clamping, so the two cannot disagree again.

export const REVIEW_TIMEOUT_DEFAULT_MS = 600_000
export const REVIEW_TIMEOUT_MAX_MS = 1_500_000
export const TEST_TIMEOUT_DEFAULT_MS = 180_000
export const TEST_TIMEOUT_MAX_MS = 600_000

/** Render a budget the way the tool descriptions quote it. */
export const asSeconds = (ms) => `${ms / 1000} s`

/** The reviewer budget actually used for a request, clamped to the documented ceiling. */
export function reviewTimeoutMs(requested) {
  return Number.isFinite(requested) && requested > 0 ? Math.min(requested, REVIEW_TIMEOUT_MAX_MS) : REVIEW_TIMEOUT_DEFAULT_MS
}

/** The budget for the bridge's own run of the caller's test command. */
export function testTimeoutMs(requested) {
  return Number.isFinite(requested) && requested > 0 ? Math.min(requested, TEST_TIMEOUT_MAX_MS) : TEST_TIMEOUT_DEFAULT_MS
}
