// ============================================================================
// DATA MODEL + PERSISTENCE — race cards, horses, localStorage, CSV import.
// Pure data layer: no React, no scoring logic (see scoring.js for that).
// ============================================================================

import { cryptoId, formatDateLong } from "./utils.js";

// CONSTANTS
// ---------------------------------------------------------------------------
const STORAGE_KEY_V3 = "horse_handicapper_v3"; // multi-card schema
const STORAGE_KEY_LEGACY_V3 = "lsp_handicapper_v3"; // same schema, prior app name
const STORAGE_KEY_V2 = "lsp_handicapper_v2"; // legacy single-card schema
const STORAGE_KEY_V1 = "lsp_handicapper_v1"; // legacy, read-only migration source
const STORAGE_KEY_PREFERENCES = "horse_handicapper_preferences_v1"; // user profile/preferences

// Bet types the person can mark as favorites in their profile.
export const BET_TYPES = ["Win", "Place", "Show", "Exacta", "Trifecta", "Superfecta", "Pick 3", "Pick 4", "Pick 5"];

// Risk tolerance affects how the AI frames advice (not the scoring math itself).
export const RISK_TOLERANCES = [
  { value: "conservative", label: "Conservative", description: "Favor higher-confidence plays, smaller stakes, more passes." },
  { value: "balanced", label: "Balanced", description: "Standard mix of confidence and opportunity." },
  { value: "aggressive", label: "Aggressive", description: "More willing to play longshots and lower-confidence value." },
];

export function defaultPreferences() {
  return {
    preferredTracks: [], // array of track name strings
    defaultBankroll: "", // pre-fills the Bankroll tab's starting bankroll for new cards
    favoriteBetTypes: [], // subset of BET_TYPES
    riskTolerance: "balanced", // one of RISK_TOLERANCES values
    aiTone: "direct", // "direct" | "detailed" | "concise" — how the AI phrases answers
    aiUsePreferencesInAdvice: true, // master toggle for whether the AI factors preferences in at all
  };
}

export function loadPreferences() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFERENCES);
    if (!raw) return defaultPreferences();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultPreferences();
    // Merge over defaults so any preference added in a future version has a
    // sane fallback for people with an older saved preferences object.
    return { ...defaultPreferences(), ...parsed };
  } catch (e) {
    console.error("Failed to load preferences", e);
    return defaultPreferences();
  }
}

export function savePreferences(preferences) {
  try {
    localStorage.setItem(STORAGE_KEY_PREFERENCES, JSON.stringify(preferences));
  } catch (e) {
    console.error("Failed to save preferences", e);
  }
}

// Default track/date used only when creating a brand-new card from scratch
// in an empty app (first-ever launch). The app is not tied to any one track
// — every card carries its own track and date once created.
const DEFAULT_TRACK = "New Race Card";
const DEFAULT_DATE = new Date().toISOString().slice(0, 10);

// Data source labels — every horse/race carries a record of where its data
// came from, so the UI can show "API" vs "Manual" vs "CSV" honestly.
const DATA_SOURCE = {
  MANUAL: "manual",
  CSV: "csv",
  API: "api",
};

export const blankHorse = () => ({
  id: cryptoId(),
  programNumber: "",
  name: "",
  jockey: "",
  trainer: "",
  mlOdds: "",
  liveOdds: "",
  scratched: false,
  dataSource: DATA_SOURCE.MANUAL,
  // Speed/form
  last3Finishes: "", // e.g. "1-3-2"
  speedFigs: "", // e.g. "82,79,85" most recent first
  daysSinceLastRace: "",
  // Pace
  runningStyle: "E", // E, EP, P, S (early, early-pace, presser, sustained/closer)
  earlyPaceRating: "",
  // Class/surface/distance
  classRating: "", // 0-100 subjective or computed
  surfaceFit: "neutral", // strong, neutral, weak
  distanceFit: "neutral",
  // Trainer/jockey win% (used in base score)
  trainerWinPct: "",
  jockeyWinPct: "",
  trainerJockeyComboWinPct: "",
  // Trainer/jockey ROI — manually entered, NOT derived from win% (different stat)
  jockeyROI: "", // e.g. "1.85" meaning $1.85 returned per $1 bet
  trainerROI: "",
  comboROI: "",
  // Workouts/layoff
  workouts: "", // free text e.g. "5f :59.4 B, 4f :48.1 H"
  workoutQuality: "neutral", // sharp, neutral, dull
  layoffDays: "",
  // Odds history — array of manually-captured snapshots, oldest first.
  // Each entry: { id, timestamp (ISO string), mlOdds, liveOdds, decOdds, source }
  // source is "manual" or "api" depending on how the snapshot was captured.
  oddsHistory: [],
  // Notes
  expertPicks: "",
  socialNotes: "",
  notes: "",
});

export const blankRace = (num) => ({
  id: cryptoId(),
  raceNumber: num,
  postTime: "",
  surface: "Dirt",
  distance: "",
  raceType: "",
  purse: "",
  fieldSizeNote: "",
  horses: [],
});

// A "card" is one race day at one track. The app now supports many of these
// side by side, switchable from the Race Cards screen, instead of one fixed
// card hardcoded to a single track/date.
export function blankCard(track, date) {
  return {
    id: cryptoId(),
    track: track || DEFAULT_TRACK,
    date: date || DEFAULT_DATE,
    createdAt: new Date().toISOString(),
    races: [blankRace(1)],
  };
}

export function duplicateCard(card, newDate) {
  // Deep-clone via JSON round-trip, then assign fresh ids everywhere so the
  // duplicate is fully independent — editing one never touches the other.
  const cloned = JSON.parse(JSON.stringify(card));
  cloned.id = cryptoId();
  cloned.date = newDate || cloned.date;
  cloned.createdAt = new Date().toISOString();
  cloned.races = cloned.races.map((r) => ({
    ...r,
    id: cryptoId(),
    horses: r.horses.map((h) => ({ ...h, id: cryptoId(), oddsHistory: [] })),
  }));
  return cloned;
}

export function formatCardLabel(card) {
  return `${card.track} — ${formatDateLong(card.date)}`;
}

// ---------------------------------------------------------------------------
// PERSISTENCE (multi-card schema, with migration from older single-card schemas)
// ---------------------------------------------------------------------------
function migrateHorseFromV1(h) {
  return {
    ...blankHorse(),
    ...h,
    jockeyROI: h.jockeyROI ?? "",
    trainerROI: h.trainerROI ?? "",
    comboROI: h.comboROI ?? "",
    oddsHistory: Array.isArray(h.oddsHistory) ? h.oddsHistory : [],
    dataSource: h.dataSource || DATA_SOURCE.MANUAL,
  };
}

function migrateCardFromV1(card) {
  return {
    id: cryptoId(),
    createdAt: new Date().toISOString(),
    ...card,
    races: (card.races || []).map((r) => ({
      ...r,
      horses: (r.horses || []).map(migrateHorseFromV1),
    })),
  };
}

export function loadState() {
  try {
    // Current schema, current app name.
    const raw = localStorage.getItem(STORAGE_KEY_V3);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.cards)) return parsed;
    }

    // Same schema, but saved under the prior app name (Lone Star Park
    // Betting Intelligence) before the rebrand to The Horse Handicapper.
    // No data transformation needed — just read it forward under the new key.
    const legacyV3Raw = localStorage.getItem(STORAGE_KEY_LEGACY_V3);
    if (legacyV3Raw) {
      const legacyV3Parsed = JSON.parse(legacyV3Raw);
      if (legacyV3Parsed && Array.isArray(legacyV3Parsed.cards)) {
        return { ...legacyV3Parsed, migratedFromOlderVersion: true };
      }
    }

    // Migrate forward from v2 (one fixed card) into v3 (array of cards).
    const v2Raw = localStorage.getItem(STORAGE_KEY_V2);
    if (v2Raw) {
      const v2Parsed = JSON.parse(v2Raw);
      if (v2Parsed && v2Parsed.card) {
        const migratedCard = migrateCardFromV1(v2Parsed.card);
        return {
          cards: [migratedCard],
          activeCardId: migratedCard.id,
          bankroll: v2Parsed.bankroll || { startingBankroll: "200", unitSize: "4" },
          migratedFromOlderVersion: true,
        };
      }
    }

    // Migrate forward from the original v1 schema directly into v3.
    const v1Raw = localStorage.getItem(STORAGE_KEY_V1);
    if (v1Raw) {
      const v1Parsed = JSON.parse(v1Raw);
      if (v1Parsed && v1Parsed.card) {
        const migratedCard = migrateCardFromV1(v1Parsed.card);
        return {
          cards: [migratedCard],
          activeCardId: migratedCard.id,
          bankroll: v1Parsed.bankroll || { startingBankroll: "200", unitSize: "4" },
          migratedFromOlderVersion: true,
        };
      }
    }

    return null;
  } catch (e) {
    console.error("Failed to load state", e);
    return null;
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save state", e);
  }
}

// ---------------------------------------------------------------------------
// CSV PARSING
// ---------------------------------------------------------------------------
const CSV_FIELD_MAP = {
  race: "raceNumber",
  racenumber: "raceNumber",
  program: "programNumber",
  programnumber: "programNumber",
  pp: "programNumber",
  number: "programNumber",
  horse: "name",
  name: "name",
  horsename: "name",
  jockey: "jockey",
  trainer: "trainer",
  mlodds: "mlOdds",
  morninglineodds: "mlOdds",
  morningline: "mlOdds",
  liveodds: "liveOdds",
  currentodds: "liveOdds",
  odds: "mlOdds",
  scratched: "scratched",
  scratch: "scratched",
  last3: "last3Finishes",
  last3finishes: "last3Finishes",
  finishes: "last3Finishes",
  speedfigs: "speedFigs",
  speedfigures: "speedFigs",
  figs: "speedFigs",
  dayssincelastrace: "daysSinceLastRace",
  runningstyle: "runningStyle",
  style: "runningStyle",
  earlypacerating: "earlyPaceRating",
  epr: "earlyPaceRating",
  classrating: "classRating",
  class: "classRating",
  surfacefit: "surfaceFit",
  distancefit: "distanceFit",
  trainerwinpct: "trainerWinPct",
  trainerwin: "trainerWinPct",
  jockeywinpct: "jockeyWinPct",
  jockeywin: "jockeyWinPct",
  combowinpct: "trainerJockeyComboWinPct",
  trainerjockeycombo: "trainerJockeyComboWinPct",
  jockeyroi: "jockeyROI",
  trainerroi: "trainerROI",
  comboroi: "comboROI",
  trainerjockeycomboroi: "comboROI",
  workouts: "workouts",
  workout: "workouts",
  workoutquality: "workoutQuality",
  layoffdays: "layoffDays",
  layoff: "layoffDays",
  expertpicks: "expertPicks",
  experts: "expertPicks",
  socialnotes: "socialNotes",
  social: "socialNotes",
  notes: "notes",
};

function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCSV(text) {
  // simple RFC4180-ish parser handling quoted fields with commas
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function csvToRaces(text, existingCard) {
  const rows = parseCSV(text);
  if (!rows.length) return { races: existingCard.races, importedCount: 0, errors: ["CSV appears empty."] };
  const headerRow = rows[0].map((h) => normalizeHeader(h));
  const fieldKeys = headerRow.map((h) => CSV_FIELD_MAP[h] || null);
  const errors = [];
  if (!fieldKeys.includes("name")) {
    errors.push('No recognizable "horse name" column found. Expected a header like "Horse" or "Name".');
    return { races: existingCard.races, importedCount: 0, errors };
  }

  const racesByNumber = {};
  existingCard.races.forEach((r) => {
    racesByNumber[r.raceNumber] = JSON.parse(JSON.stringify(r));
  });

  let importedCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const rec = {};
    fieldKeys.forEach((key, idx) => {
      if (key) rec[key] = (cols[idx] ?? "").trim();
    });
    if (!rec.name) continue;

    const raceNum = parseInt(rec.raceNumber, 10) || 1;
    if (!racesByNumber[raceNum]) {
      racesByNumber[raceNum] = blankRace(raceNum);
    }
    const horse = blankHorse();
    Object.keys(rec).forEach((k) => {
      if (k === "raceNumber") return;
      if (k === "scratched") {
        horse.scratched = /^(y|yes|true|1|scratched)$/i.test(rec[k]);
      } else if (horse.hasOwnProperty(k)) {
        horse[k] = rec[k];
      }
    });
    racesByNumber[raceNum].horses.push(horse);
    importedCount++;
  }

  const races = Object.keys(racesByNumber)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b)
    .map((n) => racesByNumber[n]);

  return { races, importedCount, errors };
}

export function exportSampleCSV() {
  const header = [
    "Race", "Program", "Horse", "Jockey", "Trainer", "MLOdds", "LiveOdds", "Scratched",
    "Last3Finishes", "SpeedFigs", "DaysSinceLastRace", "RunningStyle", "EarlyPaceRating",
    "ClassRating", "SurfaceFit", "DistanceFit", "TrainerWinPct", "JockeyWinPct",
    "TrainerJockeyComboWinPct", "JockeyROI", "TrainerROI", "ComboROI",
    "Workouts", "WorkoutQuality", "LayoffDays", "ExpertPicks", "SocialNotes", "Notes",
  ];
  const sample = [
    ["1", "3", "Lone Star Lacy", "J. Vargas", "C. Hartfield", "5/2", "3/1", "N", "1-2-1", "84,81,86", "21", "E", "62", "70", "strong", "neutral", "22", "18", "24", "1.95", "2.10", "2.40", "5f :59.4 B", "sharp", "21", "Likes the rail", "Buzz on X about sharp move", ""],
    ["1", "5", "Plano Pride", "R. Sanchez", "M. Cox", "4/1", "9/2", "N", "3-1-4", "79,80,77", "28", "P", "55", "65", "neutral", "neutral", "15", "20", "16", "1.10", "0.95", "0.90", "4f :48.1 H", "neutral", "28", "", "", ""],
  ];
  return [header.join(","), ...sample.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(","))].join("\n");
}
