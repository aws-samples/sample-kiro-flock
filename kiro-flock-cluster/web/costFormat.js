/* ============================================================================
   Shared cost formatting — single source for the credit→USD overage rate.

   All AI cost values from the API are raw credits; convert with
   creditsToUsd(). Infra costs arrive as USD already.

   Imported by sections/single-cluster.js, sections/multi-cluster.js and
   dashboard.js (all ES modules — no bundler, plain relative imports).
   ============================================================================ */

/** Overage rate in $ per credit. */
export const OVERAGE_RATE = 0.04;

/** Convert raw AI credits to USD at the overage rate. */
export function creditsToUsd(credits) {
  return credits * OVERAGE_RATE;
}

/** "12.34 cr, $0.49" — the inner credits+dollars pair used by both boards. */
export function fmtCredits(credits) {
  return `${credits.toFixed(2)} cr, $${creditsToUsd(credits).toFixed(2)}`;
}

/** "$0.0042" below a cent, "$1.23" otherwise. */
export function fmtUsd(usd) {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
