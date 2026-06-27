// ============================================================================
// PREMIUM PP PARSER — extracts what only the PP pages contain: program
// number, post position, horse name, breeding line, full running-line
// history (used to derive last3Finishes), workout lines, scratch lines,
// and the most recent medication/equipment code.
//
// Per the hybrid-source design, this parser deliberately does NOT attempt
// to read the multi-column owner/silks/trainer-stats header block (no
// shared baseline — validated as the hardest part of the page to parse
// reliably). Win%, class rating, pace/speed figures, and trainer/jockey
// stats come from speedFigureAnalysisParser.js and quickStatsParser.js
// instead.
//
// Horse-block boundary (validated against real extraction): each horse's
// data starts with a row matching "^<programNumber> Owner: ...". The
// horse's name appears in a later row ending in " (L)" or just before
// "LS:" within the same block, e.g. "Just Bernie  (L) LS: ...".
// Running lines start with the date pattern "^A\d{2}[A-Za-z]{3}\d{2}".
// ============================================================================

// Horse-block boundary, validated against REAL pdfjs-dist row output (not
// just a rendered-page visual approximation — the actual glyph coordinates
// cluster differently than other PDF tools' layout reconstruction): each
// horse's data starts with a row beginning "Owner: ...". Program numbers
// are assigned sequentially (1, 2, 3, ...) in the order Owner: blocks
// appear, rather than parsed from any specific row or glyph position —
// validated as the more robust approach since Equibase PP race cards
// always number horses sequentially starting at 1, and a glyph-coordinate
// lookup proved unreliable across page boundaries (a race's horses can
// span multiple PDF pages, and pdfjs-dist's y-coordinates do not carry a
// stable relationship across pages). The horse's name is its own
// standalone row, appearing after the post-color and medication rows.
// Running lines start with "A", optionally followed by a space, then the
// date.
const OWNER_LINE_RE = /^Owner:\s*/;
const RUNNING_LINE_START_RE = /^A\s?\d{2}[A-Za-z]{3}\d{2}/;
const WORKOUT_LINE_RE = /^Workout\(s\):\s*(.*)$/;
const SCRATCH_LINE_RE = /^Scratch\(es\):\s*(.*)$/;
const TRAINER_STATS_LINE_RE = /^Trainer \(Last 365 days\):/;

// Horse name line comes in several real formats, all confirmed in the same
// document. The common thread: the name is plain text (letters, digits,
// apostrophes, periods, spaces) at the very start of the row (after
// stripping stray control characters and an optional leading claiming-price
// token), followed by an optional parenthetical medication code, then
// either a 2-3 digit weight, "LS:", or another parenthetical (trainer-stats
// fragment, in claiming races where the name's row also carries a
// "$XX,XXX" claiming-price label from the adjacent column).
//   "Just Bernie \u0004 (L) 124"
//   "Vino Texas Jess \u0004 (L) 121"
//   "$25,000 K K's First Dance (L)  ( 147-12-12-27 ) 8%"
//   "Sawasdee (L) 120"
const HORSE_NAME_WEIGHT_OR_LS_RE = /^([A-Za-z][A-Za-z0-9'.\s]*?)\s*(?:\([A-Z0-9]{1,4}\)\s*)*(?:\d{2,3}\b|LS:)/;
const HORSE_NAME_GENERIC_PAREN_RE = /^([A-Za-z][A-Za-z0-9'.\s]*?)\s*(?:\([A-Z0-9]{1,4}\)\s*)?\(/;
const LEADING_CLAIMING_PRICE_RE = /^\$[\d,]+\s+/;

function extractHorseNameFromLine(rowRaw) {
  const row = rowRaw.replace(LEADING_CLAIMING_PRICE_RE, "");
  const weightMatch = row.match(HORSE_NAME_WEIGHT_OR_LS_RE);
  if (weightMatch) {
    const name = weightMatch[1].trim();
    if (isLikelyBreedingLine(name)) return null;
    return name;
  }
  const genericMatch = row.match(HORSE_NAME_GENERIC_PAREN_RE);
  if (genericMatch) {
    const name = genericMatch[1].trim();
    if (isLikelyBreedingLine(name)) return null;
    return name;
  }
  return null;
}

// Guards against accidentally matching a breeding-line row (e.g.
// "Dk B/ Br.g.4 Bernardini...") if one is ever encountered before the
// real name row in document order — these always start with a short
// coat-color/sex abbreviation.
function isLikelyBreedingLine(name) {
  return /^(Dk|Ch|B\.|Gr|Ro|Bl)\b/i.test(name) && name.length < 12;
}

// Extracts the finish position from a running line's chain of fractional
// call positions. The actual finish is the LAST call-position token before
// the jockey name — these tokens look like "1¶", "2«¬", "10¶¶¡" etc (a
// number followed by Equibase's proprietary margin glyphs). We only need
// the leading digit(s) of the final one. Validated against real pdfjs-dist
// extraction where jockey names retain internal spaces ("Diaz R",
// "Alvarez J L") rather than being squashed together.
const FINISH_POSITION_RE = /(\d{1,2})[^\dA-Za-z]*\s+[A-Z][a-zA-Z]*(?:\s[A-Z]\.?){0,2}\s+\d{2,3}\s*[a-zA-Z]{0,3}\s+[\d.*]/;

// Medication/equipment code: appears directly between the jockey's weight
// and the odds on each running line, e.g. "DiazR 124 bL 3.80" -> "bL"
// (blinkers + Lasix). Validated against real running lines.
const MED_EQUIPMENT_RE = /\d{3}\s+([a-zA-Z]{1,3})\s+[\d.*]/;

/**
 * @param {{pageIndex: number, rows: string[]}[]} pages - pages belonging
 *   to one race (opener + continuations), in page order
 * @returns {Array<object>} one entry per horse: { programNumber, name,
 *   lastFinishes: string[], workouts, scratches, medsEquipment }
 */
export function parsePPRace(pages) {
  const allRows = [];
  for (const { rows } of pages) {
    allRows.push(...rows);
  }

  const horses = [];
  let current = null;
  let nextProgramNumber = 1;

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];

    if (OWNER_LINE_RE.test(row)) {
      if (current) horses.push(current);
      current = {
        programNumber: String(nextProgramNumber),
        name: "",
        finishes: [],
        workouts: "",
        scratches: "",
        medsEquipment: "",
      };
      nextProgramNumber += 1;
      continue;
    }
    if (!current) continue;

    if (RUNNING_LINE_START_RE.test(row)) {
      const finishMatch = row.match(FINISH_POSITION_RE);
      if (finishMatch) {
        current.finishes.push(finishMatch[1]);
      }
      if (!current.medsEquipment) {
        const medMatch = row.match(MED_EQUIPMENT_RE);
        if (medMatch) current.medsEquipment = medMatch[1];
      }
      continue;
    }

    if (!current.name) {
      const extractedName = extractHorseNameFromLine(stripControlChars(row));
      if (extractedName) {
        current.name = extractedName;
      }
    }

    const workoutMatch = row.match(WORKOUT_LINE_RE);
    if (workoutMatch) {
      current.workouts = workoutMatch[1].trim();
      continue;
    }

    const scratchMatch = row.match(SCRATCH_LINE_RE);
    if (scratchMatch) {
      // Multiple scratch lines can appear; keep all, joined — there's no
      // schema risk in showing full scratch history as notes, and we
      // never use this to set today's scratched flag (see normalizer).
      current.scratches = current.scratches
        ? `${current.scratches}; ${scratchMatch[1].trim()}`
        : scratchMatch[1].trim();
      continue;
    }

    if (TRAINER_STATS_LINE_RE.test(row)) {
      // End of this horse's block content worth reading further for our
      // purposes (workouts/scratches always appear before this line).
      continue;
    }
  }
  if (current) horses.push(current);

  return horses.filter((h) => h.programNumber && h.name);
}

// Strips stray Unicode control characters (e.g. \u0004, \u0005) that
// appear where a proprietary Equibase glyph (medication/footnote mark) has
// no printable Unicode mapping in pdfjs-dist's extraction — confirmed
// these carry no schema-relevant information, same as the "(cid:N)"
// artifacts seen in other extraction tools for this same glyph family.
function stripControlChars(s) {
  return s.replace(/[\u0000-\u001f\u0080-\u00a0]/g, " ").replace(/\s+/g, " ").trim();
}
