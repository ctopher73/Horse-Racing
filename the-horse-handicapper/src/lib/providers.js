// ============================================================================
// DATA PROVIDER ARCHITECTURE — interfaces for future live-feed integration.
// ============================================================================
// No live racing API is connected in this version. This module exists to
// finish the *shape* of that integration so it's a clean swap later, not a
// rewrite — per the explicit instruction to prepare for live data without
// integrating it yet.
//
// Four separate interfaces, each independently swappable:
//   - EntriesProvider  : race/field data (who's running, post positions, etc.)
//   - OddsProvider     : morning line / live odds updates
//   - ResultsProvider  : finish order once a race is official
//   - ScratchesProvider: which horses are scratched
//
// Splitting these four apart (rather than one monolithic "data provider")
// matters because a real deployment might mix sources — e.g. entries from
// one vendor, live odds from a tote feed, results from a different service.
// Each interface can be satisfied by a different provider independently.
//
// HOW TO CONNECT A REAL PROVIDER LATER:
// 1. Implement an object matching the relevant interface(s) below.
// 2. Any network calls MUST go through a Netlify Function (see
//    netlify/functions/racecard.js for the existing pattern) — never call a
//    vendor API directly from the browser, and never store an API key in
//    frontend code. The provider object here can wrap a fetch() to your own
//    Netlify Function; the function holds the real vendor key server-side.
// 3. Point the relevant active*Provider constant at the new implementation.
//    Every call site already goes through these constants, so nothing else
//    in the app needs to change.
//
// This app ships with exactly one concrete provider — manualProvider — which
// satisfies all four interfaces by doing nothing (the person IS the data
// source). It's a real implementation, not a placeholder, so the interface
// always has something valid to point at.

/**
 * @typedef {Object} EntriesProvider
 * @property {string} name
 * @property {{ entries: boolean }} capabilities
 * @property {(trackName: string, date: string) => Promise<RaceEntry[] | null>} fetchEntries
 */

/**
 * @typedef {Object} OddsProvider
 * @property {string} name
 * @property {{ liveOdds: boolean }} capabilities
 * @property {(horseRef: object) => Promise<{ mlOdds?: string, liveOdds?: string } | null>} fetchOddsUpdate
 */

/**
 * @typedef {Object} ResultsProvider
 * @property {string} name
 * @property {{ results: boolean }} capabilities
 * @property {(raceRef: object) => Promise<{ finishOrder: string[] } | null>} fetchResults
 */

/**
 * @typedef {Object} ScratchesProvider
 * @property {string} name
 * @property {{ scratches: boolean }} capabilities
 * @property {(raceRef: object) => Promise<string[]>} fetchScratches
 */

// ---------------------------------------------------------------------------
// MANUAL PROVIDER — satisfies all four interfaces by doing nothing. The
// person typing data into the app IS the data source; these methods exist so
// calling code can check `provider.capabilities.X` uniformly rather than
// special-casing "no provider configured".
// ---------------------------------------------------------------------------

export const manualEntriesProvider = {
  name: "Manual entry",
  capabilities: { entries: false },
  async fetchEntries() {
    return null;
  },
};

export const manualOddsProvider = {
  name: "Manual entry",
  capabilities: { liveOdds: false },
  async fetchOddsUpdate() {
    return null;
  },
};

export const manualResultsProvider = {
  name: "Manual entry",
  capabilities: { results: false },
  async fetchResults() {
    return null;
  },
};

export const manualScratchesProvider = {
  name: "Manual entry",
  capabilities: { scratches: false },
  async fetchScratches() {
    return [];
  },
};

// ---------------------------------------------------------------------------
// ACTIVE PROVIDER SEAMS — the entire integration point for live data.
// Swapping any one of these four constants for a real implementation is all
// that's needed; nothing else in the app references a provider directly.
// ---------------------------------------------------------------------------
export const activeEntriesProvider = manualEntriesProvider;
export const activeOddsProvider = manualOddsProvider;
export const activeResultsProvider = manualResultsProvider;
export const activeScratchesProvider = manualScratchesProvider;

// Legacy combined export kept for backward compatibility with any code still
// importing the original single-object shape from earlier versions of this
// app. New code should use the four split providers above.
export const manualProvider = {
  name: "Manual entry",
  capabilities: { liveOdds: false, scratches: false, results: false },
  async fetchOddsUpdate() {
    return null;
  },
  async fetchScratches() {
    return [];
  },
  async fetchResults() {
    return null;
  },
};
export const activeProvider = manualProvider;
