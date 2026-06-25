// ============================================================================
// LONE STAR PARK BETTING INTELLIGENCE PLATFORM — single-file React app
// v2: real-time-style odds tracking (manual snapshot), movement alerts,
// smart-money heuristic, ROI inputs, layoff/workout/pace engines, Kelly sizing.
// ============================================================================
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import "./styles.css";

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const TRACK = "Lone Star Park";
const CARD_DATE = "2026-06-27";
const STORAGE_KEY_V2 = "lsp_handicapper_v2";
const STORAGE_KEY_V1 = "lsp_handicapper_v1"; // legacy, read-only migration source

const WEIGHTS = {
  speedForm: 0.25,
  paceFit: 0.20,
  classFit: 0.15,
  trainerJockey: 0.15,
  workoutsLayoff: 0.10,
  oddsValue: 0.15,
};

const TIERS = [
  { min: 85, label: "A", color: "#3C6E47", name: "Standout" },
  { min: 70, label: "B", color: "#C9A857", name: "Solid" },
  { min: 55, label: "C", color: "#A67B3D", name: "Playable" },
  { min: 40, label: "D", color: "#8B6F52", name: "Marginal" },
  { min: 0, label: "F", color: "#8B2E2E", name: "Toss" },
];

// Kelly Criterion sizing tiers — fraction of full Kelly actually recommended.
// Full Kelly is mathematically optimal for log-growth but brutally volatile;
// a fractional cap is standard practice for recreational/semi-pro bettors.
const KELLY_FRACTION_CAP = 0.25; // quarter-Kelly ceiling
const KELLY_MAX_PCT_OF_BANKROLL = 0.05; // hard cap regardless of Kelly math

const blankHorse = () => ({
  id: cryptoId(),
  programNumber: "",
  name: "",
  jockey: "",
  trainer: "",
  mlOdds: "",
  liveOdds: "",
  scratched: false,
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
  // source is always "manual" today; this field exists so a future live feed
  // can write entries with source: "api" without changing the data shape.
  oddsHistory: [],
  // Notes
  expertPicks: "",
  socialNotes: "",
  notes: "",
});

const blankRace = (num) => ({
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

function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function initialCard() {
  return {
    track: TRACK,
    date: CARD_DATE,
    races: [blankRace(1)],
  };
}

// ---------------------------------------------------------------------------
// PERSISTENCE (with one-time migration from v1 schema)
// ---------------------------------------------------------------------------
function migrateHorseFromV1(h) {
  return {
    ...blankHorse(),
    ...h,
    jockeyROI: h.jockeyROI ?? "",
    trainerROI: h.trainerROI ?? "",
    comboROI: h.comboROI ?? "",
    oddsHistory: Array.isArray(h.oddsHistory) ? h.oddsHistory : [],
  };
}

function migrateCardFromV1(card) {
  return {
    ...card,
    races: (card.races || []).map((r) => ({
      ...r,
      horses: (r.horses || []).map(migrateHorseFromV1),
    })),
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V2);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.card) return parsed;
    }
    // No v2 data yet — check for legacy v1 data to migrate forward.
    const legacyRaw = localStorage.getItem(STORAGE_KEY_V1);
    if (legacyRaw) {
      const legacyParsed = JSON.parse(legacyRaw);
      if (legacyParsed && legacyParsed.card) {
        return {
          card: migrateCardFromV1(legacyParsed.card),
          bankroll: legacyParsed.bankroll || { startingBankroll: "200", unitSize: "4" },
          migratedFromV1: true,
        };
      }
    }
    return null;
  } catch (e) {
    console.error("Failed to load state", e);
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save state", e);
  }
}

// ---------------------------------------------------------------------------
// ODDS HELPERS
// ---------------------------------------------------------------------------
// Accepts "5/2", "5-2", "2.5", "5to2", "evens", "even"
function parseOddsToDecimal(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s === "even" || s === "evens" || s === "ev") return 1.0;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*[\/\-]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const num = parseFloat(m[1]);
    const den = parseFloat(m[2]);
    if (den > 0) return num / den;
  }
  m = s.match(/^(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const num = parseFloat(m[1]);
    const den = parseFloat(m[2]);
    if (den > 0) return num / den;
  }
  const f = parseFloat(s);
  if (!isNaN(f)) return f;
  return null;
}

function decimalOddsToImpliedProb(decOdds) {
  if (decOdds == null || decOdds < 0) return null;
  return 1 / (decOdds + 1);
}

function formatOddsFraction(decOdds) {
  if (decOdds == null) return "—";
  if (Math.abs(decOdds - 1) < 0.001) return "Evens";
  // try to express as simple fraction
  const denominators = [1, 2, 3, 4, 5, 10];
  let best = null;
  for (const d of denominators) {
    const n = decOdds * d;
    if (Math.abs(n - Math.round(n)) < 0.06) {
      best = `${Math.round(n)}/${d}`;
      break;
    }
  }
  return best || decOdds.toFixed(1) + "/1";
}

// ---------------------------------------------------------------------------
// ODDS SNAPSHOT / MOVEMENT / SMART-MONEY ENGINE
// ---------------------------------------------------------------------------
// IMPORTANT — this is manually-captured data, not a live feed. Every snapshot
// is created by the person tapping "Capture odds snapshot," entering the
// board odds they're looking at right now. The shape (timestamp + source)
// is designed so a future live API integration could push entries with
// source: "api" without any change to the history/movement/alert logic below.

function currentDecOdds(horse) {
  return parseOddsToDecimal(horse.liveOdds) ?? parseOddsToDecimal(horse.mlOdds);
}

// Adds one snapshot entry to a horse's history if odds actually changed
// (or if there's no history yet). Returns the updated horse object.
function appendOddsSnapshot(horse, timestamp) {
  const decOdds = currentDecOdds(horse);
  const last = horse.oddsHistory[horse.oddsHistory.length - 1];
  if (last && last.decOdds === decOdds) {
    return horse; // no change since last snapshot — don't pad history with duplicates
  }
  const entry = {
    id: cryptoId(),
    timestamp,
    mlOdds: horse.mlOdds,
    liveOdds: horse.liveOdds,
    decOdds,
    source: "manual",
  };
  return { ...horse, oddsHistory: [...horse.oddsHistory, entry] };
}

// Snapshots every active (non-scratched, named) horse in a race at once —
// this is the "tote board refresh" action the user taps between races.
function snapshotRaceOdds(race) {
  const timestamp = new Date().toISOString();
  return {
    ...race,
    horses: race.horses.map((h) => (h.name && h.name.trim() ? appendOddsSnapshot(h, timestamp) : h)),
  };
}

// Movement direction + magnitude between the first and most recent snapshot.
// "Steam" = odds shortening (more money coming in, market likes it more).
// "Drift" = odds lengthening (market souring on it / money leaving).
function oddsMovement(horse) {
  const history = horse.oddsHistory || [];
  if (history.length < 2) return null;
  const first = history[0];
  const latest = history[history.length - 1];
  if (first.decOdds == null || latest.decOdds == null) return null;
  const delta = latest.decOdds - first.decOdds; // negative = steaming (shortened)
  const pctChange = first.decOdds > 0 ? (delta / first.decOdds) * 100 : 0;
  let direction = "stable";
  if (pctChange <= -15) direction = "steam";
  else if (pctChange >= 15) direction = "drift";
  return {
    firstDecOdds: first.decOdds,
    latestDecOdds: latest.decOdds,
    delta,
    pctChange,
    direction,
    snapshotCount: history.length,
    firstTimestamp: first.timestamp,
    latestTimestamp: latest.timestamp,
  };
}

// Smart-money heuristic: a horse whose odds are steaming significantly while
// its score doesn't (yet) fully explain the move is flagged as possible
// informed/insider money. This is a heuristic on observed price action,
// not a claim about who is betting or why.
function smartMoneyFlag(horse, movement, composite) {
  if (!movement) return null;
  if (movement.direction !== "steam") return null;
  if (movement.snapshotCount < 2) return null;
  // Bigger flag when the move is sharp (>= 25% shortening) regardless of score,
  // and an even stronger flag when the score doesn't already justify a short price.
  const sharp = movement.pctChange <= -25;
  const scoreJustifies = composite >= 70;
  if (!sharp && scoreJustifies) return null; // expected shortening for a legitimately strong horse
  return {
    strength: sharp && !scoreJustifies ? "strong" : sharp ? "moderate" : "mild",
    pctChange: movement.pctChange,
  };
}

function formatMovementSummary(movement) {
  if (!movement) return "No movement data yet";
  const arrow = movement.direction === "steam" ? "↓" : movement.direction === "drift" ? "↑" : "→";
  const pct = Math.abs(movement.pctChange).toFixed(0);
  if (movement.direction === "stable") return `${arrow} Stable (${movement.snapshotCount} snapshots)`;
  const verb = movement.direction === "steam" ? "Steaming" : "Drifting";
  return `${arrow} ${verb} ${pct}% (${formatOddsFraction(movement.firstDecOdds)} → ${formatOddsFraction(movement.latestDecOdds)})`;
}

// ---------------------------------------------------------------------------
// SCORING ENGINE
// ---------------------------------------------------------------------------
// Each sub-score returns 0-100. Final = weighted sum.

function scoreSpeedForm(h) {
  let score = 50;
  const figs = (h.speedFigs || "")
    .split(",")
    .map((x) => parseFloat(x.trim()))
    .filter((x) => !isNaN(x));
  if (figs.length) {
    const avg = figs.reduce((a, b) => a + b, 0) / figs.length;
    // normalize: assume typical claiming/allowance fig range 60-100 at this level
    score = clamp(((avg - 55) / (100 - 55)) * 100, 0, 100);
    // trend bonus: improving figs (most recent first) get a bump
    if (figs.length >= 2) {
      const trend = figs[0] - figs[figs.length - 1];
      score += clamp(trend * 1.5, -10, 10);
    }
  }
  const finishes = (h.last3Finishes || "")
    .split(/[-,]/)
    .map((x) => parseInt(x.trim(), 10))
    .filter((x) => !isNaN(x));
  if (finishes.length) {
    const avgFinish = finishes.reduce((a, b) => a + b, 0) / finishes.length;
    const finishScore = clamp(((6 - avgFinish) / 5) * 100, 0, 100);
    score = figs.length ? score * 0.7 + finishScore * 0.3 : finishScore;
  }
  return clamp(score, 0, 100);
}

function scorePaceFit(h, allHorses) {
  // Uses the shared pace projection engine so the score and the visible
  // race-shape summary always agree with each other.
  const projection = projectPaceShape(allHorses);
  const style = h.runningStyle || "P";
  const epr = parseFloat(h.earlyPaceRating);

  let base = 50;
  if (projection.shape === "lone_speed") {
    if (style === "E") base = 88;
    else if (style === "EP") base = 70;
    else if (style === "P") base = 55;
    else base = 40;
  } else if (projection.shape === "speed_duel") {
    if (style === "S") base = 85;
    else if (style === "P") base = 70;
    else if (style === "EP") base = 45;
    else base = 30;
  } else if (projection.shape === "contested") {
    if (style === "S") base = 72;
    else if (style === "P") base = 68;
    else if (style === "EP") base = 55;
    else base = 45;
  } else {
    if (style === "EP") base = 72;
    else if (style === "P") base = 65;
    else if (style === "E") base = 58;
    else base = 50;
  }

  if (!isNaN(epr)) {
    base += clamp((epr - 50) / 5, -8, 8);
  }
  return clamp(base, 0, 100);
}

function scoreClassFit(h) {
  let score = parseFloat(h.classRating);
  if (isNaN(score)) score = 55;
  const surfMod = { strong: 10, neutral: 0, weak: -15 }[h.surfaceFit || "neutral"];
  const distMod = { strong: 10, neutral: 0, weak: -15 }[h.distanceFit || "neutral"];
  return clamp(score + surfMod + distMod, 0, 100);
}

function scoreTrainerJockey(h) {
  const tw = parseFloat(h.trainerWinPct);
  const jw = parseFloat(h.jockeyWinPct);
  const combo = parseFloat(h.trainerJockeyComboWinPct);
  const tROI = parseFloat(h.trainerROI);
  const jROI = parseFloat(h.jockeyROI);
  const cROI = parseFloat(h.comboROI);

  const parts = [];
  if (!isNaN(tw)) parts.push(clamp((tw / 30) * 100, 0, 100));
  if (!isNaN(jw)) parts.push(clamp((jw / 30) * 100, 0, 100));
  if (!isNaN(combo)) parts.push(clamp((combo / 35) * 100, 0, 100) * 1.15);

  // ROI is a distinct signal from win% — a trainer can win often at short
  // prices (low ROI) or win less often but at prices that pay (high ROI).
  // ROI is expressed as $ returned per $1 bet; 1.00 = breakeven.
  const roiParts = [];
  if (!isNaN(tROI)) roiParts.push(clamp(((tROI - 0.6) / (1.6 - 0.6)) * 100, 0, 100));
  if (!isNaN(jROI)) roiParts.push(clamp(((jROI - 0.6) / (1.6 - 0.6)) * 100, 0, 100));
  if (!isNaN(cROI)) roiParts.push(clamp(((cROI - 0.6) / (1.6 - 0.6)) * 100, 0, 100) * 1.1);

  if (!parts.length && !roiParts.length) return 50;
  const winPctAvg = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  const roiAvg = roiParts.length ? roiParts.reduce((a, b) => a + b, 0) / roiParts.length : null;

  if (winPctAvg != null && roiAvg != null) {
    // Weight win% slightly higher since it's a larger sample in most cases,
    // but ROI meaningfully shifts the score — a low-ROI high-win% trainer
    // is often just running short-priced favorites that don't profit.
    return clamp(winPctAvg * 0.6 + roiAvg * 0.4, 0, 100);
  }
  return clamp(winPctAvg ?? roiAvg, 0, 100);
}

// LAYOFF ANALYSIS — returns a labeled, explainable breakdown (not just a number)
function analyzeLayoff(h) {
  const layoff = parseFloat(h.layoffDays);
  if (isNaN(layoff)) {
    return { score: 55, label: "Unknown", detail: "No layoff data entered.", hasData: false };
  }
  if (layoff <= 21) {
    return { score: 63, label: "Fresh", detail: `${layoff}d off — racing into form, minimal rust concern.`, hasData: true };
  }
  if (layoff <= 45) {
    return { score: 57, label: "Normal cycle", detail: `${layoff}d off — typical spacing between starts.`, hasData: true };
  }
  if (layoff <= 90) {
    return { score: 47, label: "Moderate layoff", detail: `${layoff}d off — some rust risk unless workouts are sharp.`, hasData: true };
  }
  if (layoff <= 180) {
    return { score: 37, label: "Long layoff", detail: `${layoff}d off — significant time away; needs strong work tab to trust.`, hasData: true };
  }
  return { score: 25, label: "Very long layoff", detail: `${layoff}d off — extended absence, hardest to trust off the bench.`, hasData: true };
}

// WORKOUT ANALYSIS — labeled grade plus the raw work line for the person to read
function analyzeWorkout(h) {
  const quality = h.workoutQuality || "neutral";
  const gradeMap = {
    sharp: { score: 80, label: "Sharp", detail: "Recent works graded sharp — bullet or near-bullet times." },
    neutral: { score: 55, label: "Adequate", detail: "Works are unremarkable — neither a red flag nor a standout." },
    dull: { score: 30, label: "Dull", detail: "Works graded dull — below-par times for the barn or surface." },
  };
  const grade = gradeMap[quality] || gradeMap.neutral;
  return {
    score: grade.score,
    label: grade.label,
    detail: grade.detail,
    workLine: h.workouts || "No workout line entered.",
    hasData: !!h.workouts || quality !== "neutral",
  };
}

function scoreWorkoutsLayoff(h) {
  const layoff = analyzeLayoff(h);
  const workout = analyzeWorkout(h);
  // Workout quality matters slightly more than raw layoff days, since a sharp
  // work tab can mitigate rust concerns from time off.
  return clamp(layoff.score * 0.45 + workout.score * 0.55, 0, 100);
}

function scoreOddsValue(h, fairProb) {
  // fairProb: this horse's modeled win probability (from non-odds scores)
  // compare to market implied prob from ML/live odds
  const decOdds = currentDecOdds(h);
  const marketProb = decimalOddsToImpliedProb(decOdds);
  if (marketProb == null || fairProb == null) return 50;
  const edge = fairProb - marketProb; // positive = underlay value
  // scale: +20 edge points -> ~100, -20 -> 0, 0 -> 50
  return clamp(50 + edge * 250, 0, 100);
}

function clamp(v, lo, hi) {
  if (typeof v !== "number" || isNaN(v)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}

// Build full score breakdown + composite for one horse within a race
// ---------------------------------------------------------------------------
// PACE PROJECTION ENGINE
// ---------------------------------------------------------------------------
// Classifies the likely shape of the race based on running styles present,
// and returns structured + plain-language output so it can be shown directly
// to the person, not just used as a hidden scoring input.
function projectPaceShape(activeHorses) {
  const styles = activeHorses.map((h) => h.runningStyle || "P");
  const counts = { E: 0, EP: 0, P: 0, S: 0 };
  styles.forEach((s) => {
    if (counts[s] != null) counts[s]++;
  });
  const total = activeHorses.length || 1;
  const earlyCount = counts.E + counts.EP;
  const earlyRatio = earlyCount / total;

  let shape, label, description;
  if (total === 0) {
    shape = "unknown";
    label = "No data";
    description = "No horses entered yet.";
  } else if (counts.E <= 1 && earlyRatio <= 0.25) {
    shape = "lone_speed";
    label = "Lone speed likely";
    description = counts.E === 1
      ? "Only one true front-runner in the field — a soft, uncontested early pace favors that horse wiring the field."
      : "No committed front-runners — pace could be soft and tactical, favoring horses near the front early.";
  } else if (earlyRatio >= 0.45) {
    shape = "speed_duel";
    label = "Speed duel likely";
    description = `${earlyCount} of ${total} horses are early types (E/EP) — a hot, contested pace is likely, which sets up for closers late.`;
  } else if (earlyRatio >= 0.3) {
    shape = "contested";
    label = "Moderately contested";
    description = `${earlyCount} of ${total} horses want the lead — some pressure on the front end, but not a guaranteed meltdown.`;
  } else {
    shape = "balanced";
    label = "Balanced pace";
    description = "Running styles are spread fairly evenly — no strong pace bias expected either way.";
  }

  return { shape, label, description, counts, earlyRatio, total };
}

function computeHorseScore(h, allActiveHorses) {
  const speedForm = scoreSpeedForm(h);
  const paceFit = scorePaceFit(h, allActiveHorses);
  const classFit = scoreClassFit(h);
  const trainerJockey = scoreTrainerJockey(h);
  const workoutsLayoff = scoreWorkoutsLayoff(h);

  // pre-odds composite used as "fair" model strength, normalized 0-1 as a probability proxy
  const preOddsComposite =
    speedForm * WEIGHTS.speedForm +
    paceFit * WEIGHTS.paceFit +
    classFit * WEIGHTS.classFit +
    trainerJockey * WEIGHTS.trainerJockey +
    workoutsLayoff * WEIGHTS.workoutsLayoff;
  const preOddsWeightSum =
    WEIGHTS.speedForm + WEIGHTS.paceFit + WEIGHTS.classFit + WEIGHTS.trainerJockey + WEIGHTS.workoutsLayoff;
  const preOddsNormalized = preOddsComposite / preOddsWeightSum; // 0-100 scale

  return {
    speedForm,
    paceFit,
    classFit,
    trainerJockey,
    workoutsLayoff,
    preOddsNormalized,
  };
}

// Convert pre-odds normalized scores across a field into fair win probabilities
// using a softmax-like distribution so they sum to ~1.
function fieldFairProbabilities(activeHorses, breakdowns) {
  const exponent = 3.2; // controls separation between contenders
  const raw = activeHorses.map((h) => Math.pow(Math.max(breakdowns[h.id].preOddsNormalized, 1), exponent));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const probs = {};
  activeHorses.forEach((h, i) => {
    probs[h.id] = raw[i] / sum;
  });
  return probs;
}

function computeRaceScores(race) {
  const activeHorses = race.horses.filter((h) => !h.scratched && h.name && h.name.trim());
  const paceProjection = projectPaceShape(activeHorses);
  const breakdowns = {};
  activeHorses.forEach((h) => {
    breakdowns[h.id] = computeHorseScore(h, activeHorses);
  });
  const fairProbs = fieldFairProbabilities(activeHorses, breakdowns);

  const results = activeHorses.map((h) => {
    const b = breakdowns[h.id];
    const oddsValue = scoreOddsValue(h, fairProbs[h.id]);
    const composite =
      b.speedForm * WEIGHTS.speedForm +
      b.paceFit * WEIGHTS.paceFit +
      b.classFit * WEIGHTS.classFit +
      b.trainerJockey * WEIGHTS.trainerJockey +
      b.workoutsLayoff * WEIGHTS.workoutsLayoff +
      oddsValue * WEIGHTS.oddsValue;
    const decOdds = currentDecOdds(h);
    const marketProb = decimalOddsToImpliedProb(decOdds);
    const compositeClamped = clamp(composite, 0, 100);
    const movement = oddsMovement(h);
    const smartMoney = smartMoneyFlag(h, movement, compositeClamped);
    return {
      horse: h,
      breakdown: { ...b, oddsValue },
      layoff: analyzeLayoff(h),
      workout: analyzeWorkout(h),
      movement,
      smartMoney,
      fairProb: fairProbs[h.id],
      marketProb,
      decOdds,
      composite: compositeClamped,
    };
  });

  results.sort((a, b) => b.composite - a.composite);
  return { results, paceProjection };
}

function tierFor(score) {
  return TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];
}

// ---------------------------------------------------------------------------
// KELLY CRITERION BET SIZING
// ---------------------------------------------------------------------------
// Kelly fraction f* = (bp - q) / b, where:
//   b = net decimal odds (e.g. 3/1 -> b=3, meaning win $3 per $1 staked)
//   p = model's fair win probability
//   q = 1 - p
// f* is the theoretically optimal fraction of bankroll to wager. Full Kelly
// is extremely volatile in practice (one bad run can halve a bankroll), so
// this app caps at a fraction of full Kelly AND a hard ceiling on bankroll %.
function kellyStake(decOdds, fairProb, bankroll) {
  if (decOdds == null || fairProb == null || decOdds <= 0 || fairProb <= 0 || fairProb >= 1) {
    return { fullKellyPct: 0, recommendedPct: 0, recommendedStake: 0, edge: null, isNegativeEdge: true };
  }
  const b = decOdds;
  const p = fairProb;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  const isNegativeEdge = fullKelly <= 0;
  const fullKellyPct = clamp(fullKelly * 100, 0, 100);

  // Apply fractional Kelly cap, then a hard ceiling regardless of math,
  // since recreational/semi-pro bettors should never bet a true full-Kelly
  // stake — variance at full Kelly is brutal even when the edge is real.
  let recommendedPct = isNegativeEdge ? 0 : fullKelly * KELLY_FRACTION_CAP * 100;
  recommendedPct = clamp(recommendedPct, 0, KELLY_MAX_PCT_OF_BANKROLL * 100);
  const bankrollNum = parseFloat(bankroll) || 0;
  const recommendedStake = bankrollNum * (recommendedPct / 100);

  return {
    fullKellyPct: Math.round(fullKellyPct * 10) / 10,
    recommendedPct: Math.round(recommendedPct * 10) / 10,
    recommendedStake: Math.round(recommendedStake * 100) / 100,
    edge: (b * p - q),
    isNegativeEdge,
  };
}

// ---------------------------------------------------------------------------
// CHAOS / SKIP-RACE DETECTOR
// ---------------------------------------------------------------------------
function assessChaos(race, scored) {
  const reasons = [];
  let chaosPoints = 0;
  const active = scored.length;

  if (active >= 10) {
    chaosPoints += 2;
    reasons.push(`Large field (${active} runners) — more trip trouble, harder to read.`);
  } else if (active >= 8) {
    chaosPoints += 1;
    reasons.push(`Full field (${active} runners) adds variance.`);
  } else if (active > 0 && active < 3) {
    chaosPoints += 3;
    reasons.push(`Only ${active} horse${active === 1 ? "" : "s"} entered — too few to read pace or build exotics confidently.`);
  }

  // Pace meltdown risk
  const earlyCount = race.horses.filter((h) => !h.scratched && (h.runningStyle === "E" || h.runningStyle === "EP")).length;
  const earlyRatio = active ? earlyCount / active : 0;
  if (earlyRatio >= 0.5 && active >= 5) {
    chaosPoints += 2;
    reasons.push("Speed duel likely — multiple early types could collapse the pace.");
  }

  // Top scores bunched together = no real standout
  if (scored.length >= 3) {
    const top3 = scored.slice(0, 3).map((s) => s.composite);
    const spread = top3[0] - top3[2];
    if (spread <= 6) {
      chaosPoints += 2;
      reasons.push("Top three horses are nearly tied on score — no clear standout.");
    } else if (spread <= 10) {
      chaosPoints += 1;
      reasons.push("Top contenders are closely bunched.");
    }
  }

  // Heavy scratches relative to original field
  const scratchedCount = race.horses.filter((h) => h.scratched).length;
  if (scratchedCount >= 2) {
    chaosPoints += 1;
    reasons.push(`${scratchedCount} scratches — field and pace shape may have changed late.`);
  }

  // Lots of horses with weak/no data (notes blank everywhere) = low confidence
  const dataPoor = race.horses.filter(
    (h) => !h.scratched && h.name && !h.speedFigs && !h.last3Finishes && !h.classRating
  ).length;
  if (dataPoor >= Math.ceil(active / 2) && active > 0) {
    chaosPoints += 2;
    reasons.push("Thin data on over half the field — model confidence is low.");
  }

  // No horse clears a "playable" floor
  if (scored.length && scored[0].composite < 55) {
    chaosPoints += 2;
    reasons.push("Even the top-rated horse scores below a playable threshold.");
  }

  const skipRace = chaosPoints >= 5;
  const level = chaosPoints >= 5 ? "high" : chaosPoints >= 3 ? "moderate" : "low";

  return { chaosPoints, reasons, skipRace, level };
}

// ---------------------------------------------------------------------------
// CONFIDENCE LEVEL
// ---------------------------------------------------------------------------
function confidenceLevel(scored, chaos) {
  if (!scored.length) return { label: "No data", pct: 0 };
  const top = scored[0].composite;
  const second = scored[1] ? scored[1].composite : 0;
  const spread = top - second;
  let pct = clamp(top * 0.55 + spread * 3, 5, 97);
  if (chaos.level === "high") pct = clamp(pct - 25, 5, 97);
  else if (chaos.level === "moderate") pct = clamp(pct - 10, 5, 97);
  let label = "Low";
  if (pct >= 70) label = "High";
  else if (pct >= 45) label = "Medium";
  return { label, pct: Math.round(pct) };
}

// ---------------------------------------------------------------------------
// BET RECOMMENDATION ENGINE
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// BET RECOMMENDATION ENGINE (Kelly-sized)
// ---------------------------------------------------------------------------
function buildBetRecommendations(scored, chaos, bankrollSettings) {
  if (chaos.skipRace || scored.length === 0) {
    return { skip: true, bets: [], betPass: "Pass", betPassReason: "Race flagged to skip." };
  }
  const [first, second, third, fourth] = scored;
  const bets = [];
  const bankrollAmt = parseFloat(bankrollSettings?.startingBankroll) || 0;
  const unit = parseFloat(bankrollSettings?.unitSize) || 2;

  const firstKelly = kellyStake(first.decOdds, first.fairProb, bankrollAmt);
  const stakeFor = (kelly) => {
    // Fall back to flat unit sizing if bankroll isn't set or Kelly says no edge
    if (!bankrollAmt || kelly.isNegativeEdge) return unit;
    return Math.max(1, Math.round(kelly.recommendedStake));
  };

  // WIN
  let bestWinBet = null;
  if (first.composite >= 60) {
    bestWinBet = {
      type: "Win",
      detail: `#${first.horse.programNumber || "?"} ${first.horse.name}`,
      stake: stakeFor(firstKelly),
      kelly: firstKelly,
      rationale: "Top-rated horse clears the playable threshold.",
    };
    bets.push(bestWinBet);
  }

  // PLACE
  if (first.composite >= 55 && first.composite < 75) {
    bets.push({
      type: "Place",
      detail: `#${first.horse.programNumber || "?"} ${first.horse.name}`,
      stake: unit,
      kelly: null,
      rationale: "Solid but not dominant — place cushions against an upset.",
    });
  }

  // EXACTA
  let bestExacta = null;
  if (second) {
    bestExacta = {
      type: "Exacta",
      detail: `#${first.horse.programNumber || "?"} / #${second.horse.programNumber || "?"} (key over)`,
      stake: unit,
      kelly: null,
      rationale: `Box if scores are close (gap: ${(first.composite - second.composite).toFixed(1)} pts), key straight if wide.`,
    };
    bets.push(bestExacta);
  }

  // TRIFECTA
  let bestTrifecta = null;
  if (third) {
    const names = [first, second, third].map((s) => `#${s.horse.programNumber || "?"}`).join(" / ");
    bestTrifecta = {
      type: "Trifecta",
      detail: `${names}${fourth ? ` (consider 4th: #${fourth.horse.programNumber || "?"} for box)` : ""}`,
      stake: unit,
      kelly: null,
      rationale: "Top three by score, boxed or keyed depending on confidence.",
    };
    bets.push(bestTrifecta);
  }

  // BET / PASS — a single clear call to action, separate from individual bet lines
  let betPass = "Pass";
  let betPassReason = "No bet clears the model's confidence and edge bar for this race.";
  if (bestWinBet && !firstKelly.isNegativeEdge && firstKelly.fullKellyPct > 0) {
    betPass = "Bet";
    betPassReason = `Top pick shows a positive edge at current odds (${firstKelly.fullKellyPct.toFixed(1)}% full-Kelly edge).`;
  } else if (bestWinBet) {
    betPass = "Bet (small)";
    betPassReason = "Top pick clears the score threshold, but odds don't show a strong price edge — bet light or stick to exotics.";
  }

  return { skip: false, bets, bestWinBet, bestExacta, bestTrifecta, betPass, betPassReason };
}

// ---------------------------------------------------------------------------
// RACE SUMMARY — Best Win / Best Value / Best Exacta / Best Trifecta /
// Best Longshot / Fade Favorite / Confidence / Bet-Pass, all in one place.
// ---------------------------------------------------------------------------
function buildRaceSummary(race, bankrollSettings) {
  const { results: scored, paceProjection } = computeRaceScores(race);
  const chaos = assessChaos(race, scored);
  const confidence = confidenceLevel(scored, chaos);
  const betRec = buildBetRecommendations(scored, chaos, bankrollSettings);

  const topPick = scored[0] || null;

  // Best value = highest (fairProb - marketProb) among horses scoring decently
  let bestValue = null;
  scored.forEach((s) => {
    if (s.marketProb == null) return;
    const edge = s.fairProb - s.marketProb;
    if (s.composite >= 45 && (!bestValue || edge > bestValue.edge)) {
      bestValue = { ...s, edge };
    }
  });

  // Best longshot = decent score (>=45) but long market odds (decOdds >= 8)
  let bestLongshot = null;
  scored.forEach((s) => {
    if (s.decOdds != null && s.decOdds >= 8 && s.composite >= 45) {
      if (!bestLongshot || s.composite > bestLongshot.composite) {
        bestLongshot = s;
      }
    }
  });

  // Fade favorite = lowest market odds (favorite) whose composite score is mediocre/poor
  let fadeFavorite = null;
  let lowestOdds = Infinity;
  let favorite = null;
  scored.forEach((s) => {
    if (s.decOdds != null && s.decOdds < lowestOdds) {
      lowestOdds = s.decOdds;
      favorite = s;
    }
  });
  if (favorite && favorite.composite < 60 && favorite.horse.id !== topPick?.horse.id) {
    fadeFavorite = favorite;
  } else if (favorite && favorite.composite < 55) {
    fadeFavorite = favorite;
  }

  // Smart-money flags across the field, surfaced at race level for quick scanning
  const smartMoneyHorses = scored.filter((s) => s.smartMoney);

  return {
    scored,
    paceProjection,
    chaos,
    confidence,
    betRec,
    topPick,
    bestValue,
    bestLongshot,
    fadeFavorite,
    smartMoneyHorses,
  };
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

function csvToRaces(text, existingCard) {
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

function exportSampleCSV() {
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

// ---------------------------------------------------------------------------
// DATA PROVIDER ARCHITECTURE — designed for future live-feed integration
// ---------------------------------------------------------------------------
// Every odds/scratch/result update in this app currently flows through one
// of the functions below, regardless of whether the person typed it in,
// uploaded a CSV, or (in the future) a live API pushed it. That's
// deliberate: it means a live data integration is a matter of writing one
// new provider that calls the same update functions, not rebuilding the
// scoring/UI layer.
//
// HOW TO ADD A LIVE PROVIDER LATER:
// 1. Implement a provider object matching DataProviderInterface below,
//    backed by a real API (e.g. a tote/odds vendor, Equibase, a results feed).
// 2. The provider's fetchOddsUpdate() should return the same shape that
//    appendOddsSnapshot() already consumes: { mlOdds, liveOdds, decOdds }.
//    Feed it through appendOddsSnapshot(horse, timestamp, source: "api")
//    instead of "manual" — every downstream function (movement, smart-money,
//    Kelly sizing) already works on decOdds/timestamp and does not care
//    where the number came from.
// 3. Scratches/results would similarly call the same setScratched / update
//    functions the manual UI calls today — see ACTIONS below.
// 4. Because this app has no backend, a live provider would run client-side
//    (e.g. fetch() against a vendor API with a key the user supplies) or via
//    a small proxy server the user points the app at. Neither exists today;
//    this section only documents the seam so that work is additive, not a
//    rewrite.
//
// This app ships with exactly one provider: manualProvider. It does not
// fetch anything — it exists so the interface has a real implementation to
// point at, and so "manual" is treated as a first-class data source rather
// than a fallback.

const DataProviderInterface = {
  // name: string shown in the UI as the data source label
  // fetchOddsUpdate(horseRef) => Promise<{ mlOdds, liveOdds } | null>
  // fetchScratches(raceRef) => Promise<string[] /* program numbers */>
  // fetchResults(raceRef) => Promise<{ finishOrder: string[] } | null>
  // capabilities: { liveOdds: bool, scratches: bool, results: bool }
};

const manualProvider = {
  name: "Manual entry",
  capabilities: { liveOdds: false, scratches: false, results: false },
  // Manual provider does not fetch — the person IS the data source.
  // This stub exists so calling code has one consistent shape to check
  // (provider.capabilities.liveOdds) rather than special-casing "no provider".
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

// activeProvider is a seam: swapping this constant for a real implementation
// (once one exists) is the entire integration point for live data.
const activeProvider = manualProvider;

// ---------------------------------------------------------------------------
// SMALL UI PRIMITIVES
// ---------------------------------------------------------------------------
function ScoreStamp({ score, size = 56 }) {
  const tier = tierFor(score);
  const r = size / 2 - 3;
  const circumference = 2 * Math.PI * r;
  const dash = (clamp(score, 0, 100) / 100) * circumference;
  return (
    <div className="score-stamp" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(245,239,224,0.12)"
          strokeWidth="3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tier.color}
          strokeWidth="3"
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="score-stamp-inner">
        <span className="score-stamp-num">{Math.round(score)}</span>
        <span className="score-stamp-tier" style={{ color: tier.color }}>{tier.label}</span>
      </div>
    </div>
  );
}

function Pill({ children, tone = "default" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function SectionLabel({ children }) {
  return <div className="section-label">{children}</div>;
}

function EmptyState({ title, body, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-body">{body}</div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HORSE FORM (manual entry)
// ---------------------------------------------------------------------------
function HorseForm({ horse, onChange, onRemove, onClose }) {
  const set = (field) => (e) => {
    onChange({ ...horse, [field]: e.target.value });
  };
  const setChecked = (field) => (e) => onChange({ ...horse, [field]: e.target.checked });

  return (
    <div className="horse-form">
      <div className="horse-form-header">
        <div className="horse-form-title">
          {horse.name ? horse.name : "New Horse"}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Program #</span>
          <input value={horse.programNumber} onChange={set("programNumber")} placeholder="3" inputMode="numeric" />
        </label>
        <label className="field field-scratch">
          <span>Scratched</span>
          <input type="checkbox" checked={horse.scratched} onChange={setChecked("scratched")} />
        </label>
      </div>

      <label className="field">
        <span>Horse name</span>
        <input value={horse.name} onChange={set("name")} placeholder="Lone Star Lacy" />
      </label>

      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Jockey</span>
          <input value={horse.jockey} onChange={set("jockey")} placeholder="J. Vargas" />
        </label>
        <label className="field">
          <span>Trainer</span>
          <input value={horse.trainer} onChange={set("trainer")} placeholder="C. Hartfield" />
        </label>
      </div>

      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Morning line odds</span>
          <input value={horse.mlOdds} onChange={set("mlOdds")} placeholder="5/2" />
        </label>
        <label className="field">
          <span>Live odds (optional)</span>
          <input value={horse.liveOdds} onChange={set("liveOdds")} placeholder="3/1" />
        </label>
      </div>

      {horse.oddsHistory && horse.oddsHistory.length > 0 && (
        <div className="odds-history-block">
          <div className="odds-history-label">Odds history <span className="data-source-tag">MANUAL DATA</span></div>
          <div className="odds-history-list">
            {horse.oddsHistory.slice().reverse().map((snap) => (
              <div className="odds-history-row" key={snap.id}>
                <span>{formatTimeShort(snap.timestamp)}</span>
                <span>{snap.liveOdds || snap.mlOdds || "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <SectionLabel>Speed / Form</SectionLabel>
      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Last 3 finishes</span>
          <input value={horse.last3Finishes} onChange={set("last3Finishes")} placeholder="1-3-2" />
        </label>
        <label className="field">
          <span>Speed figs (recent→old)</span>
          <input value={horse.speedFigs} onChange={set("speedFigs")} placeholder="84,81,86" />
        </label>
      </div>

      <SectionLabel>Pace</SectionLabel>
      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Running style</span>
          <select value={horse.runningStyle} onChange={set("runningStyle")}>
            <option value="E">E — Early / Speed</option>
            <option value="EP">EP — Early-Presser</option>
            <option value="P">P — Presser</option>
            <option value="S">S — Sustained / Closer</option>
          </select>
        </label>
        <label className="field">
          <span>Early pace rating (0–100)</span>
          <input value={horse.earlyPaceRating} onChange={set("earlyPaceRating")} placeholder="62" inputMode="numeric" />
        </label>
      </div>

      <SectionLabel>Class / Surface / Distance</SectionLabel>
      <div className="form-grid form-grid-3">
        <label className="field">
          <span>Class rating (0–100)</span>
          <input value={horse.classRating} onChange={set("classRating")} placeholder="70" inputMode="numeric" />
        </label>
        <label className="field">
          <span>Surface fit</span>
          <select value={horse.surfaceFit} onChange={set("surfaceFit")}>
            <option value="strong">Strong</option>
            <option value="neutral">Neutral</option>
            <option value="weak">Weak</option>
          </select>
        </label>
        <label className="field">
          <span>Distance fit</span>
          <select value={horse.distanceFit} onChange={set("distanceFit")}>
            <option value="strong">Strong</option>
            <option value="neutral">Neutral</option>
            <option value="weak">Weak</option>
          </select>
        </label>
      </div>

      <SectionLabel>Trainer / Jockey — Win %</SectionLabel>
      <div className="form-grid form-grid-3">
        <label className="field">
          <span>Trainer win %</span>
          <input value={horse.trainerWinPct} onChange={set("trainerWinPct")} placeholder="22" inputMode="numeric" />
        </label>
        <label className="field">
          <span>Jockey win %</span>
          <input value={horse.jockeyWinPct} onChange={set("jockeyWinPct")} placeholder="18" inputMode="numeric" />
        </label>
        <label className="field">
          <span>T/J combo win %</span>
          <input value={horse.trainerJockeyComboWinPct} onChange={set("trainerJockeyComboWinPct")} placeholder="24" inputMode="numeric" />
        </label>
      </div>

      <SectionLabel>Trainer / Jockey — ROI <span className="field-hint">($ returned per $1 bet — manual entry, e.g. from Equibase)</span></SectionLabel>
      <div className="form-grid form-grid-3">
        <label className="field">
          <span>Trainer ROI</span>
          <input value={horse.trainerROI} onChange={set("trainerROI")} placeholder="1.85" inputMode="decimal" />
        </label>
        <label className="field">
          <span>Jockey ROI</span>
          <input value={horse.jockeyROI} onChange={set("jockeyROI")} placeholder="1.40" inputMode="decimal" />
        </label>
        <label className="field">
          <span>Combo ROI</span>
          <input value={horse.comboROI} onChange={set("comboROI")} placeholder="2.10" inputMode="decimal" />
        </label>
      </div>

      <SectionLabel>Workouts / Layoff</SectionLabel>
      <label className="field">
        <span>Workout line</span>
        <input value={horse.workouts} onChange={set("workouts")} placeholder='5f :59.4 B, 4f :48.1 H' />
      </label>
      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Workout quality</span>
          <select value={horse.workoutQuality} onChange={set("workoutQuality")}>
            <option value="sharp">Sharp</option>
            <option value="neutral">Neutral</option>
            <option value="dull">Dull</option>
          </select>
        </label>
        <label className="field">
          <span>Days since last race</span>
          <input value={horse.layoffDays} onChange={set("layoffDays")} placeholder="21" inputMode="numeric" />
        </label>
      </div>
      <div className="inline-analysis-row">
        <span className="inline-analysis-chip">Layoff read: {analyzeLayoff(horse).label}</span>
        <span className="inline-analysis-chip">Workout grade: {analyzeWorkout(horse).label}</span>
      </div>

      <SectionLabel>Notes</SectionLabel>
      <label className="field">
        <span>Expert picks</span>
        <textarea value={horse.expertPicks} onChange={set("expertPicks")} placeholder="DRF: top pick. Twinspires: 2nd choice." rows={2} />
      </label>
      <label className="field">
        <span>Social media notes</span>
        <textarea value={horse.socialNotes} onChange={set("socialNotes")} placeholder="Trainer posted on X about a sharp recent breeze." rows={2} />
      </label>
      <label className="field">
        <span>Other notes</span>
        <textarea value={horse.notes} onChange={set("notes")} rows={2} />
      </label>

      <button className="btn btn-danger btn-block" onClick={onRemove}>Remove horse</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HORSE ROW (list display in Horses tab)
// ---------------------------------------------------------------------------
function HorseRow({ result, rank, onEdit }) {
  const { horse, composite, breakdown, decOdds, movement, smartMoney } = result;
  const tier = tierFor(composite);
  return (
    <button className="horse-row" onClick={onEdit}>
      <div className="horse-row-rank">{rank}</div>
      <div className="horse-row-pp">{horse.programNumber || "–"}</div>
      <div className="horse-row-main">
        <div className="horse-row-name">
          {horse.name || "Unnamed horse"}
          {smartMoney && <span className={`smart-money-badge smart-money-badge-${smartMoney.strength}`}>$</span>}
        </div>
        <div className="horse-row-sub">
          {horse.jockey && <span>{horse.jockey}</span>}
          {horse.trainer && <span> · {horse.trainer}</span>}
        </div>
        <div className="horse-row-odds">
          ML {horse.mlOdds || "—"}{horse.liveOdds ? ` → ${horse.liveOdds}` : ""}
        </div>
        {movement && movement.direction !== "stable" && (
          <div className={`horse-row-movement horse-row-movement-${movement.direction}`}>
            {formatMovementSummary(movement)}
          </div>
        )}
      </div>
      <ScoreStamp score={composite} size={48} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// RACE SUMMARY CARD (used in Dashboard)
// ---------------------------------------------------------------------------
function RaceSummaryCard({ race, summary, onOpen }) {
  const { topPick, bestValue, bestLongshot, fadeFavorite, chaos, confidence, betRec, smartMoneyHorses } = summary;
  return (
    <button className="race-card" onClick={onOpen}>
      <div className="race-card-top">
        <div className="race-card-num">R{race.raceNumber}</div>
        <div className="race-card-meta">
          <div className="race-card-time">{race.postTime || "Post TBA"}</div>
          <div className="race-card-cond">
            {race.surface || "Dirt"} · {race.distance || "—"}
          </div>
        </div>
        {chaos.skipRace ? (
          <Pill tone="danger">SKIP</Pill>
        ) : (
          <Pill tone={betRec.betPass === "Pass" ? "default" : "bet"}>{betRec.betPass.toUpperCase()}</Pill>
        )}
      </div>

      {topPick ? (
        <div className="race-card-pick">
          <ScoreStamp score={topPick.composite} size={44} />
          <div className="race-card-pick-info">
            <div className="race-card-pick-label">Top pick</div>
            <div className="race-card-pick-name">
              #{topPick.horse.programNumber || "?"} {topPick.horse.name}
            </div>
          </div>
        </div>
      ) : (
        <div className="race-card-pick race-card-pick-empty">No horses entered yet</div>
      )}

      {!chaos.skipRace && (
        <div className="race-card-tags">
          {bestValue && <Pill tone="value">Value: #{bestValue.horse.programNumber || "?"}</Pill>}
          {bestLongshot && <Pill tone="longshot">Longshot: #{bestLongshot.horse.programNumber || "?"}</Pill>}
          {fadeFavorite && <Pill tone="fade">Fade: #{fadeFavorite.horse.programNumber || "?"}</Pill>}
          {smartMoneyHorses && smartMoneyHorses.length > 0 && (
            <Pill tone="smart">$ Smart money: #{smartMoneyHorses[0].horse.programNumber || "?"}</Pill>
          )}
        </div>
      )}

      <div className="race-card-footer">
        <span className={`confidence-tag confidence-${confidence.label.toLowerCase()}`}>
          {confidence.label} confidence ({confidence.pct}%)
        </span>
        <span className="race-card-bets">
          {chaos.skipRace ? "No bets recommended" : `${betRec.bets.length} bet${betRec.bets.length === 1 ? "" : "s"} suggested`}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// RACE DETAIL VIEW
// ---------------------------------------------------------------------------
function RaceDetail({ race, summary, onUpdateRace, onAddHorse, onEditHorse, onSnapshotOdds, bankroll }) {
  const { scored, paceProjection, chaos, confidence, betRec, topPick, bestValue, bestLongshot, fadeFavorite, smartMoneyHorses } = summary;

  const setField = (field) => (e) => onUpdateRace({ ...race, [field]: e.target.value });

  const lastSnapshotTime = useMemo(() => {
    let latest = null;
    race.horses.forEach((h) => {
      const hist = h.oddsHistory || [];
      const last = hist[hist.length - 1];
      if (last && (!latest || last.timestamp > latest)) latest = last.timestamp;
    });
    return latest;
  }, [race.horses]);

  return (
    <div className="race-detail">
      <div className="race-detail-header card">
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>Post time</span>
            <input value={race.postTime} onChange={setField("postTime")} placeholder="1:05 PM" />
          </label>
          <label className="field">
            <span>Surface</span>
            <select value={race.surface} onChange={setField("surface")}>
              <option>Dirt</option>
              <option>Turf</option>
              <option>Synthetic</option>
            </select>
          </label>
        </div>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>Distance</span>
            <input value={race.distance} onChange={setField("distance")} placeholder="6f" />
          </label>
          <label className="field">
            <span>Race type / purse</span>
            <input value={race.raceType} onChange={setField("raceType")} placeholder="Alw 32000, $32k" />
          </label>
        </div>
      </div>

      <div className="card odds-snapshot-card">
        <div className="card-title-row">
          <span className="card-title">Odds tracking</span>
          <span className="data-source-tag">MANUAL DATA</span>
        </div>
        <p className="muted-text">
          Tap below to log every horse's current odds as a timestamped snapshot. The app compares
          snapshots over time to flag steam (shortening) and drift (lengthening). This is not a live
          feed — it only knows what you enter, when you enter it.
        </p>
        <button className="btn btn-block" onClick={() => onSnapshotOdds(race.id)}>📸 Capture odds snapshot now</button>
        <div className="muted-text odds-snapshot-meta">
          {lastSnapshotTime
            ? `Last snapshot: ${formatTimeShort(lastSnapshotTime)}`
            : "No snapshots captured yet for this race."}
        </div>
      </div>

      {chaos.skipRace && (
        <div className="warning-banner">
          <div className="warning-banner-title">⚠ Skip-race warning</div>
          <div className="warning-banner-body">
            This race looks too chaotic to bet with confidence.
          </div>
          <ul className="warning-list">
            {chaos.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {!chaos.skipRace && chaos.level === "moderate" && (
        <div className="warning-banner warning-banner-mild">
          <div className="warning-banner-title">Some chaos signals</div>
          <ul className="warning-list">
            {chaos.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      <div className={`card bet-pass-banner bet-pass-${betRec.skip ? "pass" : slugify(betRec.betPass)}`}>
        <div className="bet-pass-label">{betRec.skip ? "PASS" : betRec.betPass.toUpperCase()}</div>
        <div className="bet-pass-reason">{betRec.skip ? chaos.reasons[0] || "Too chaotic to bet." : betRec.betPassReason}</div>
      </div>

      <div className="card">
        <div className="card-title">Race-shape summary</div>
        <div className="pace-shape-label">{paceProjection.label}</div>
        <p className="muted-text">{paceProjection.description}</p>
        <div className="pace-style-counts">
          <span>E: {paceProjection.counts.E}</span>
          <span>EP: {paceProjection.counts.EP}</span>
          <span>P: {paceProjection.counts.P}</span>
          <span>S: {paceProjection.counts.S}</span>
        </div>
      </div>

      {smartMoneyHorses && smartMoneyHorses.length > 0 && (
        <div className="card smart-money-card">
          <div className="card-title">$ Smart-money signals</div>
          {smartMoneyHorses.map((s) => (
            <div className="smart-money-row" key={s.horse.id}>
              <span className="smart-money-strength">{s.smartMoney.strength}</span>
              <span>#{s.horse.programNumber || "?"} {s.horse.name} — {formatMovementSummary(s.movement)}</span>
            </div>
          ))}
          <p className="muted-text" style={{ marginTop: 8 }}>
            Based on odds you've captured manually, not a live feed. A heuristic, not proof of insider money.
          </p>
        </div>
      )}

      <div className="card summary-grid">
        <SummaryBlock label="Top pick" item={topPick} tone="pick" />
        <SummaryBlock label="Best value" item={bestValue} tone="value" extra={bestValue ? `+${(bestValue.edge * 100).toFixed(1)}pt edge` : null} />
        <SummaryBlock label="Best longshot" item={bestLongshot} tone="longshot" />
        <SummaryBlock label="Fade favorite" item={fadeFavorite} tone="fade" />
      </div>

      <div className="card">
        <div className="card-title-row">
          <span className="card-title">Confidence</span>
          <span className={`confidence-tag confidence-${confidence.label.toLowerCase()}`}>
            {confidence.label} ({confidence.pct}%)
          </span>
        </div>
        <div className="confidence-bar">
          <div className="confidence-bar-fill" style={{ width: `${confidence.pct}%` }} />
        </div>
      </div>

      <div className="card">
        <div className="card-title">Suggested bets</div>
        {chaos.skipRace ? (
          <div className="muted-text">No bets recommended — see skip warning above.</div>
        ) : betRec.bets.length ? (
          <div className="bet-list">
            {betRec.bets.map((b, i) => (
              <div className="bet-row" key={i}>
                <div className="bet-row-type">{b.type}</div>
                <div className="bet-row-detail">
                  <div className="bet-row-detail-main">{b.detail}</div>
                  <div className="bet-row-detail-sub">{b.rationale}</div>
                  {b.kelly && !b.kelly.isNegativeEdge && bankroll?.startingBankroll && (
                    <div className="bet-row-kelly">
                      Kelly: {b.kelly.fullKellyPct.toFixed(1)}% full · using {(KELLY_FRACTION_CAP * 100).toFixed(0)}% fraction,
                      capped at {(KELLY_MAX_PCT_OF_BANKROLL * 100).toFixed(0)}% of bankroll
                    </div>
                  )}
                  {b.kelly && b.kelly.isNegativeEdge && (
                    <div className="bet-row-kelly bet-row-kelly-negative">
                      Kelly: no price edge at current odds — flat unit used instead
                    </div>
                  )}
                </div>
                <div className="bet-row-stake">${b.stake}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted-text">No standout bets — field too even or all scores too low.</div>
        )}
      </div>

      <div className="card">
        <div className="card-title-row">
          <span className="card-title">Horses ({scored.length})</span>
          <button className="btn btn-small" onClick={onAddHorse}>+ Add horse</button>
        </div>
        {scored.length ? (
          <div className="horse-list">
            {scored.map((r, i) => (
              <HorseRow key={r.horse.id} result={r} rank={i + 1} onEdit={() => onEditHorse(r.horse)} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No horses yet"
            body="Add horses manually or import a CSV from the Data tab."
            action={<button className="btn btn-small" onClick={onAddHorse}>+ Add first horse</button>}
          />
        )}
        {race.horses.some((h) => h.scratched) && (
          <div className="scratch-note">
            Scratched: {race.horses.filter((h) => h.scratched).map((h) => `#${h.programNumber || "?"} ${h.name}`).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimeShort(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function SummaryBlock({ label, item, tone, extra }) {
  return (
    <div className={`summary-block summary-block-${tone}`}>
      <div className="summary-block-label">{label}</div>
      {item ? (
        <>
          <div className="summary-block-name">#{item.horse.programNumber || "?"} {item.horse.name}</div>
          <div className="summary-block-score">
            <ScoreStamp score={item.composite} size={32} />
            <span className="summary-block-odds">{item.horse.liveOdds || item.horse.mlOdds || "—"}</span>
            {extra && <span className="summary-block-extra">{extra}</span>}
          </div>
        </>
      ) : (
        <div className="summary-block-none">None identified</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DASHBOARD VIEW
// ---------------------------------------------------------------------------
function Dashboard({ card, summaries, onOpenRace, onAddRace }) {
  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="dashboard-track">{card.track}</div>
        <div className="dashboard-date">{formatDateLong(card.date)}</div>
      </div>
      <div className="race-card-list">
        {card.races.map((race) => (
          <RaceSummaryCard
            key={race.id}
            race={race}
            summary={summaries[race.id]}
            onOpen={() => onOpenRace(race.id)}
          />
        ))}
        <button className="add-race-card" onClick={onAddRace}>
          <span className="add-race-plus">+</span>
          <span>Add race</span>
        </button>
      </div>
    </div>
  );
}

function formatDateLong(iso) {
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// BANKROLL MANAGER
// ---------------------------------------------------------------------------
function BankrollManager({ bankroll, onChange, card, summaries }) {
  const set = (field) => (e) => onChange({ ...bankroll, [field]: e.target.value });

  const totalSuggestedStake = useMemo(() => {
    let total = 0;
    Object.values(summaries).forEach((s) => {
      if (!s.chaos.skipRace) {
        s.betRec.bets.forEach((b) => (total += Number(b.stake) || 0));
      }
    });
    return total;
  }, [summaries]);

  const startingBankroll = parseFloat(bankroll.startingBankroll) || 0;
  const unitSize = parseFloat(bankroll.unitSize) || 0;
  const unitPct = startingBankroll ? (unitSize / startingBankroll) * 100 : 0;
  const recommendedUnit = startingBankroll ? clamp(startingBankroll * 0.02, 1, startingBankroll) : 0;

  return (
    <div className="bankroll">
      <div className="card">
        <div className="card-title">Today's bankroll</div>
        <label className="field">
          <span>Starting bankroll ($)</span>
          <input value={bankroll.startingBankroll} onChange={set("startingBankroll")} inputMode="decimal" placeholder="200" />
        </label>
        <label className="field">
          <span>Unit size ($)</span>
          <input value={bankroll.unitSize} onChange={set("unitSize")} inputMode="decimal" placeholder="2" />
        </label>
        <div className="bankroll-hint">
          {startingBankroll > 0 && (
            <>
              Your unit is {unitPct.toFixed(1)}% of bankroll.{" "}
              {unitPct >= 5 ? (
                <span className="hint-warning">That's aggressive — consider sizing down toward ${recommendedUnit.toFixed(0)} (2%).</span>
              ) : (
                <span className="hint-good">That's a reasonably conservative size.</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Today's exposure</div>
        <div className="bankroll-stat-row">
          <span>Suggested stakes across all races</span>
          <span className="bankroll-stat-value">${totalSuggestedStake.toFixed(0)}</span>
        </div>
        <div className="bankroll-stat-row">
          <span>Remaining after suggested bets</span>
          <span className="bankroll-stat-value">${Math.max(0, startingBankroll - totalSuggestedStake).toFixed(0)}</span>
        </div>
        {startingBankroll > 0 && totalSuggestedStake > startingBankroll && (
          <div className="hint-warning" style={{ marginTop: 8 }}>
            Suggested stakes exceed your bankroll for the day. Consider skipping marginal races or lowering your unit size.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">By race</div>
        <div className="bankroll-race-list">
          {card.races.map((race) => {
            const s = summaries[race.id];
            const stake = s.chaos.skipRace ? 0 : s.betRec.bets.reduce((a, b) => a + (Number(b.stake) || 0), 0);
            return (
              <div className="bankroll-race-row" key={race.id}>
                <span>R{race.raceNumber}</span>
                <span className={s.chaos.skipRace ? "muted-text" : ""}>
                  {s.chaos.skipRace ? "Skip" : `${s.betRec.bets.length} bet(s)`}
                </span>
                <span className="bankroll-stat-value">${stake.toFixed(0)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Bet sizing method</div>
        <p className="muted-text">
          When a bet shows a price edge, suggested win stakes use a quarter-Kelly fraction of your bankroll
          (capped at {(KELLY_MAX_PCT_OF_BANKROLL * 100).toFixed(0)}% of bankroll regardless of the math), not
          full Kelly. Full Kelly is mathematically optimal for long-run growth but far too volatile for
          everyday betting — a quarter-Kelly cap trades some growth for a much smoother bankroll. When there's
          no price edge at current odds, the app falls back to your flat unit size instead.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Ground rules</div>
        <ul className="rules-list">
          <li>Never bet more than one unit on a single horse to win unless confidence is High.</li>
          <li>Skip races flagged chaotic — preserving bankroll is a result, not a non-result.</li>
          <li>Re-check live odds against morning line before locking bets — value can disappear at the windows.</li>
          <li>This tool is a decision aid, not a guarantee. Bet only what you can afford to lose.</li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DATA TAB — manual entry shortcuts + CSV upload
// ---------------------------------------------------------------------------
function DataTab({ card, onAddHorseToRace, onCSVImport, races }) {
  const fileInputRef = useRef(null);
  const [importMsg, setImportMsg] = useState(null);
  const [selectedRace, setSelectedRace] = useState(card.races[0]?.id || "");

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const { races: newRaces, importedCount, errors } = csvToRaces(text, card);
      if (errors.length) {
        setImportMsg({ tone: "error", text: errors.join(" ") });
        return;
      }
      onCSVImport(newRaces);
      setImportMsg({ tone: "success", text: `Imported ${importedCount} horse row${importedCount === 1 ? "" : "s"} across ${newRaces.length} race(s).` });
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const downloadSample = () => {
    const blob = new Blob([exportSampleCSV()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lsp_handicapper_sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="data-tab">
      <div className="card">
        <div className="card-title">CSV upload</div>
        <p className="muted-text">
          Upload past performances, odds, trainer/jockey stats, and notes in bulk. Include a "Race" column
          to assign horses to race numbers automatically.
        </p>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: "none" }} />
        <button className="btn btn-block" onClick={() => fileInputRef.current?.click()}>Choose CSV file</button>
        <button className="btn btn-ghost btn-block" onClick={downloadSample}>Download sample CSV format</button>
        {importMsg && <div className={`import-msg import-msg-${importMsg.tone}`}>{importMsg.text}</div>}
      </div>

      <div className="card">
        <div className="card-title">Manual entry</div>
        <p className="muted-text">Jump straight to adding a horse to a specific race.</p>
        <label className="field">
          <span>Race</span>
          <select value={selectedRace} onChange={(e) => setSelectedRace(e.target.value)}>
            {races.map((r) => (
              <option key={r.id} value={r.id}>Race {r.raceNumber}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-block" onClick={() => onAddHorseToRace(selectedRace)}>+ Add horse to selected race</button>
      </div>

      <div className="card">
        <div className="card-title">Scoring weights (reference)</div>
        <div className="weights-list">
          <WeightRow label="Speed / Form" pct={25} />
          <WeightRow label="Pace fit" pct={20} />
          <WeightRow label="Class / Surface / Distance" pct={15} />
          <WeightRow label="Trainer / Jockey" pct={15} />
          <WeightRow label="Workouts / Layoff" pct={10} />
          <WeightRow label="Odds value" pct={15} />
        </div>
      </div>
    </div>
  );
}

function WeightRow({ label, pct }) {
  return (
    <div className="weight-row">
      <span className="weight-row-label">{label}</span>
      <div className="weight-row-bar-track">
        <div className="weight-row-bar-fill" style={{ width: `${pct * 3}%` }} />
      </div>
      <span className="weight-row-pct">{pct}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROOT APP
// ---------------------------------------------------------------------------
export default function App() {
  const initialLoad = useMemo(() => loadState(), []);
  const [card, setCard] = useState(() => initialLoad?.card || initialCard());
  const [bankroll, setBankroll] = useState(
    () => initialLoad?.bankroll || { startingBankroll: "200", unitSize: "4" }
  );
  const [showMigrationNotice, setShowMigrationNotice] = useState(!!initialLoad?.migratedFromV1);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [openRaceId, setOpenRaceId] = useState(null);
  const [editingHorse, setEditingHorse] = useState(null); // { raceId, horse }

  useEffect(() => {
    saveState({ card, bankroll });
  }, [card, bankroll]);

  const updateRace = useCallback((updatedRace) => {
    setCard((prev) => ({
      ...prev,
      races: prev.races.map((r) => (r.id === updatedRace.id ? updatedRace : r)),
    }));
  }, []);

  const addRace = useCallback(() => {
    setCard((prev) => {
      const nextNum = (prev.races[prev.races.length - 1]?.raceNumber || 0) + 1;
      return { ...prev, races: [...prev.races, blankRace(nextNum)] };
    });
  }, []);

  const addHorseToRace = useCallback((raceId) => {
    setCard((prev) => {
      const race = prev.races.find((r) => r.id === raceId);
      if (!race) return prev;
      const newHorse = blankHorse();
      const updatedRace = { ...race, horses: [...race.horses, newHorse] };
      setEditingHorse({ raceId, horse: newHorse });
      setActiveTab("dashboard");
      setOpenRaceId(raceId);
      return { ...prev, races: prev.races.map((r) => (r.id === raceId ? updatedRace : r)) };
    });
  }, []);

  const updateHorse = useCallback((raceId, updatedHorse) => {
    setCard((prev) => ({
      ...prev,
      races: prev.races.map((r) =>
        r.id === raceId
          ? { ...r, horses: r.horses.map((h) => (h.id === updatedHorse.id ? updatedHorse : h)) }
          : r
      ),
    }));
    setEditingHorse((prev) => (prev && prev.horse.id === updatedHorse.id ? { ...prev, horse: updatedHorse } : prev));
  }, []);

  const removeHorse = useCallback((raceId, horseId) => {
    setCard((prev) => ({
      ...prev,
      races: prev.races.map((r) =>
        r.id === raceId ? { ...r, horses: r.horses.filter((h) => h.id !== horseId) } : r
      ),
    }));
    setEditingHorse(null);
  }, []);

  const handleCSVImport = useCallback((newRaces) => {
    setCard((prev) => ({ ...prev, races: newRaces }));
  }, []);

  const snapshotOddsForRace = useCallback((raceId) => {
    setCard((prev) => ({
      ...prev,
      races: prev.races.map((r) => (r.id === raceId ? snapshotRaceOdds(r) : r)),
    }));
  }, []);

  const summaries = useMemo(() => {
    const map = {};
    card.races.forEach((race) => {
      map[race.id] = buildRaceSummary(race, bankroll);
    });
    return map;
  }, [card, bankroll]);

  const openRace = card.races.find((r) => r.id === openRaceId) || null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <span className="app-header-mark">LSP</span>
          <span>Betting Intelligence</span>
        </div>
        <div className="app-header-sub">{card.track} · {formatDateLong(card.date)}</div>
      </header>

      {showMigrationNotice && (
        <div className="migration-notice">
          Upgraded from the previous version — your races and horses carried over. New fields (ROI, odds
          history) start blank until you fill them in.
          <button className="icon-btn" onClick={() => setShowMigrationNotice(false)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <main className="app-main">
        {activeTab === "dashboard" && !openRace && (
          <Dashboard card={card} summaries={summaries} onOpenRace={setOpenRaceId} onAddRace={addRace} />
        )}

        {activeTab === "dashboard" && openRace && (
          <div className="race-detail-wrap">
            <button className="back-btn" onClick={() => setOpenRaceId(null)}>← All races</button>
            <RaceDetail
              race={openRace}
              summary={summaries[openRace.id]}
              onUpdateRace={updateRace}
              onAddHorse={() => addHorseToRace(openRace.id)}
              onEditHorse={(horse) => setEditingHorse({ raceId: openRace.id, horse })}
              onSnapshotOdds={snapshotOddsForRace}
              bankroll={bankroll}
            />
          </div>
        )}

        {activeTab === "data" && (
          <DataTab
            card={card}
            races={card.races}
            onAddHorseToRace={(raceId) => {
              addHorseToRace(raceId);
            }}
            onCSVImport={handleCSVImport}
          />
        )}

        {activeTab === "bankroll" && (
          <BankrollManager bankroll={bankroll} onChange={setBankroll} card={card} summaries={summaries} />
        )}
      </main>

      {editingHorse && (
        <div className="modal-overlay" onClick={() => setEditingHorse(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <HorseForm
              horse={editingHorse.horse}
              onChange={(h) => updateHorse(editingHorse.raceId, h)}
              onRemove={() => removeHorse(editingHorse.raceId, editingHorse.horse.id)}
              onClose={() => setEditingHorse(null)}
            />
          </div>
        </div>
      )}

      <nav className="tab-bar">
        <TabButton label="Races" active={activeTab === "dashboard"} onClick={() => { setActiveTab("dashboard"); setOpenRaceId(null); }} />
        <TabButton label="Data" active={activeTab === "data"} onClick={() => { setActiveTab("data"); setOpenRaceId(null); }} />
        <TabButton label="Bankroll" active={activeTab === "bankroll"} onClick={() => { setActiveTab("bankroll"); setOpenRaceId(null); }} />
      </nav>
    </div>
  );
}

function TabButton({ label, active, onClick }) {
  return (
    <button className={`tab-btn ${active ? "tab-btn-active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}
