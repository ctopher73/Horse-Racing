// ============================================================================
// SECTION DETECTION — splits the flattened row stream into the report
// sections an Equibase Premium PP export concatenates into one PDF.
//
// Confirmed against a real 79-page Lone Star Park export during development:
//   pages 0-2   Speed Figure Analysis (one row per horse, all races)
//   pages 3-38  Premium PP pages (one race opener + continuation pages)
//   page 39     Meet Leaders (track-wide jockey/trainer stats — not used)
//   page 40     Horses In Today (track-wide index — not used)
//   pages 41-43 Quick Stats (one row per horse, all races)
//   pages 44+   Class Graphs / Speed Graphs (chart data — not used; the
//               class rating and speed figures we need already come from
//               Speed Figure Analysis)
//
// Section boundaries are detected by marker strings rather than hardcoded
// page numbers, since a different date/card will have a different page
// count (8-race vs 12-race cards, etc).
// ============================================================================

const MARKERS = {
  speedFigureAnalysis: "Speed Figure Analysis for",
  meetLeaders: "MEET LEADERS AT",
  horsesInToday: "Horses In Today",
  quickStats: "Quick Stats",
  classGraphs: "Class Graphs",
  speedGraphs: "Speed Graphs",
};

// A PP race-opener page always carries "APPROX. POST:" plus "Program Help"
// near the top of the page; continuation pages carry "RACE n CONTINUED".
const PP_OPENER_MARKER = "APPROX. POST:";
const PP_CONTINUED_MARKER = "CONTINUED";

// Validated against the REAL pdfjs-dist coordinate output (not just a
// rendered-page visual approximation): the race number and race rating
// share one row that sits immediately after a "Race Rating" row and
// immediately before the "equibase.com/QR" row. The race number is always
// the first of the two numbers on that row. This anchor was confirmed
// reliable across multiple races including double-digit race numbers.
const RACE_RATING_MARKER = "Race Rating";
const QR_MARKER_FOR_RACE_NUM = "equibase.com/QR";
const RACE_NUMBER_ROW_RE = /^(\d{1,2})\s+\d{1,3}$/;

/**
 * Extracts the race number from a PP opener page's rows.
 * @param {string[]} rows
 * @returns {number|null}
 */
export function extractRaceNumber(rows) {
  const ratingIdx = rows.findIndex((r) => r.trim() === RACE_RATING_MARKER);
  if (ratingIdx === -1) return null;
  for (let i = ratingIdx + 1; i < rows.length; i++) {
    if (rows[i].includes(QR_MARKER_FOR_RACE_NUM)) break;
    const m = rows[i].match(RACE_NUMBER_ROW_RE);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// The opener page's second row is consistently
// "MM/DD/YY APPROX. POST: H:MMAM/PM ..." — this gives us date and post time
// directly without needing the rendered "Saturday, June 27, 2026" banner
// text (which varies in format across exports).
const POST_TIME_LINE_RE = /^(\d{2}\/\d{2}\/\d{2})\s+APPROX\.\s*POST:\s*([\d:]+\s*[AP]M)/i;

/**
 * Classifies every page by which section it belongs to.
 * @param {{pageIndex: number, rows: string[]}[]} pages
 * @returns {{
 *   speedFigureAnalysisPages: number[],
 *   ppOpenerPages: number[],
 *   ppContinuationPages: number[],
 *   quickStatsPages: number[],
 *   meetLeadersPages: number[],
 *   horsesInTodayPages: number[],
 * }}
 */
export function classifyPages(pages) {
  const result = {
    speedFigureAnalysisPages: [],
    ppOpenerPages: [],
    ppContinuationPages: [],
    quickStatsPages: [],
    meetLeadersPages: [],
    horsesInTodayPages: [],
  };

  for (const { pageIndex, rows } of pages) {
    const joined = rows.join(" ");
    if (joined.includes(MARKERS.speedFigureAnalysis)) {
      result.speedFigureAnalysisPages.push(pageIndex);
    } else if (joined.includes(MARKERS.meetLeaders)) {
      result.meetLeadersPages.push(pageIndex);
    } else if (joined.includes(MARKERS.horsesInToday)) {
      result.horsesInTodayPages.push(pageIndex);
    } else if (joined.includes(MARKERS.quickStats) && !joined.includes(MARKERS.speedFigureAnalysis)) {
      // Class/Speed Graphs pages also contain race-condition text but not
      // "Quick Stats"; this guard avoids misclassifying them.
      result.quickStatsPages.push(pageIndex);
    } else if (joined.includes(PP_OPENER_MARKER)) {
      result.ppOpenerPages.push(pageIndex);
    } else if (joined.includes(PP_CONTINUED_MARKER) && /RACE\s*\d+\s*CONTINUED/i.test(joined)) {
      result.ppContinuationPages.push(pageIndex);
    }
    // Class Graphs / Speed Graphs pages intentionally fall through
    // unclassified — they're not a data source for any schema field.
  }

  return result;
}

/**
 * Groups PP pages (opener + its continuations) by race number, using the
 * race number that appears at the top of each PP opener page and the
 * "RACE n CONTINUED" marker on continuation pages.
 * @returns {Map<number, number[]>} raceNumber -> array of pageIndexes, in order
 */
/**
 * Extracts the card date (YYYY-MM-DD) and this race's post time from a PP
 * opener page's rows, using the validated "MM/DD/YY APPROX. POST: H:MMAM/PM"
 * header line that appears as the second row on every opener page.
 * @returns {{ date: string|null, postTime: string|null }}
 */
export function extractDateAndPostTime(rows) {
  for (const row of rows.slice(0, 4)) {
    const m = row.match(POST_TIME_LINE_RE);
    if (m) {
      const [, mmddyy, postTime] = m;
      const [mm, dd, yy] = mmddyy.split("/");
      // Equibase prints 2-digit years; this card family is clearly 20xx.
      const yyyy = `20${yy}`;
      return { date: `${yyyy}-${mm}-${dd}`, postTime: postTime.trim() };
    }
  }
  return { date: null, postTime: null };
}

export function groupPPPagesByRace(pages, classified) {
  const raceToPages = new Map();
  const allPPPages = [...classified.ppOpenerPages, ...classified.ppContinuationPages].sort((a, b) => a - b);
  const pageRowsByIndex = new Map(pages.map((p) => [p.pageIndex, p.rows]));

  let currentRace = null;
  for (const pageIndex of allPPPages) {
    const rows = pageRowsByIndex.get(pageIndex) || [];
    const joined = rows.join(" ");
    const continuedMatch = joined.match(/RACE\s*(\d+)\s*CONTINUED/i);
    if (continuedMatch) {
      currentRace = parseInt(continuedMatch[1], 10);
    } else {
      const raceNum = extractRaceNumber(rows);
      currentRace = raceNum != null ? raceNum : (currentRace != null ? currentRace + 1 : 1);
    }
    if (!raceToPages.has(currentRace)) raceToPages.set(currentRace, []);
    raceToPages.get(currentRace).push(pageIndex);
  }

  return raceToPages;
}
