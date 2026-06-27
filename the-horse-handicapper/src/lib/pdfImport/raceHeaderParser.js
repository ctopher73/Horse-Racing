// ============================================================================
// RACE HEADER PARSER — extracts race-level fields from a PP opener page.
//
// Every pattern here was validated against a real 12-race Lone Star Park
// Premium PP export before being written, including a turf stakes race
// (trailing "(Turf)" suffix), a maiden race, and an allowance race, to make
// sure the regex handles real variation rather than just the first example
// seen.
// ============================================================================

import { extractDateAndPostTime, extractRaceNumber } from "./sectionDetection.js";

const PURSE_RE = /Purse\s+\$([\d,]+)/;
const TRACK_RECORD_MARKER = "Track Record:";

// The race-type line is the row immediately after the "equibase.com/QR"
// marker row on every opener page; for stakes races, it includes the stakes
// name appended ("STAKES Texas Turf Classic S.").
const QR_MARKER = "equibase.com/QR";

// Distance/surface: the condition paragraph's trailing phrase, which is NOT
// reliably anchored on a "Furlongs"/"Miles" unit word at the very end —
// phrasings like "One Mile And One Eighth" end in a word ("Eighth") that
// isn't a distance unit at all. Validated fix: strip an optional trailing
// "(Turf)" surface marker, then look for the LAST genuine sentence-closing
// parenthetical ("...Eighth.)") — present whenever a "run on main track if
// turf is unsafe" clause precedes the distance phrase — and take everything
// after it. An early aside like "(PLUS UP TO $2,070 FROM ATBOIA)" must NOT
// be used as the anchor even though it's also parenthetical, since it sits
// mid-paragraph, not at a sentence boundary; only a closing paren
// immediately preceded by a period qualifies. Falls back to the text after
// the last ". " when no such parenthetical exists at all.
function extractDistanceAndSurface(conditionText) {
  let text = conditionText.trim();
  let surface = "Dirt";

  const surfaceMatch = text.match(/\((Turf|Dirt|All Weather)\)\s*$/i);
  if (surfaceMatch) {
    if (surfaceMatch[1].toLowerCase() === "turf") surface = "Turf";
    text = text.slice(0, surfaceMatch.index).trim();
  }

  let lastSentenceCloseParen = -1;
  const sentenceCloseRe = /\.\)\s*/g;
  let match;
  while ((match = sentenceCloseRe.exec(text)) !== null) {
    lastSentenceCloseParen = match.index + match[0].length;
  }

  let distance;
  if (lastSentenceCloseParen !== -1) {
    distance = text.slice(lastSentenceCloseParen).trim();
  } else {
    const lastPeriodIdx = text.lastIndexOf(". ");
    distance = lastPeriodIdx !== -1 ? text.slice(lastPeriodIdx + 2).trim() : text;
  }
  distance = distance.replace(/^[.\s]+/, "");

  return { distance, surface };
}

/**
 * @param {string[]} rows - all rows from one PP opener page
 * @param {string} trackName - track name, supplied once for the whole card
 *   (Equibase PP pages don't repeat the track name on every opener row in a
 *   form worth re-parsing per page; it's read once from the Speed Figure
 *   Analysis banner — see equibaseParser.js)
 * @returns {object} partial race fields matching blankRace() shape
 */
export function parseRaceHeader(rows, trackName) {
  const raceNumber = extractRaceNumber(rows);

  const { date, postTime } = extractDateAndPostTime(rows);

  const qrIdx = rows.findIndex((r) => r.includes(QR_MARKER));
  const raceTypeRow = qrIdx >= 0 ? rows[qrIdx + 1] || "" : "";
  const raceType = raceTypeRow.trim();

  // Condition paragraph: every row from the race-type row up to (excluding)
  // the "Track Record:" row. Joining these and reading from the tail is
  // necessary because stakes-race conditions wrap across many rows, and the
  // distance/surface phrase is always the very last thing before the track
  // record line, never on a predictable fixed row offset.
  const trackRecordIdx = rows.findIndex((r) => r.startsWith(TRACK_RECORD_MARKER));
  const conditionRows =
    qrIdx >= 0 && trackRecordIdx > qrIdx ? rows.slice(qrIdx + 1, trackRecordIdx) : [];
  const conditionText = conditionRows.join(" ");

  const purseMatch = conditionText.match(PURSE_RE);
  const purse = purseMatch ? purseMatch[1] : "";

  const { distance, surface } = extractDistanceAndSurface(conditionText);

  return {
    raceNumber,
    track: trackName || "",
    date: date || "",
    postTime: postTime || "",
    raceType,
    purse,
    distance,
    surface,
  };
}
