// ============================================================================
// COACH ENGINE — natural-language Q&A and proactive insights over the
// existing scoring/bankroll/odds-movement/pace engines.
// ============================================================================
// IMPORTANT DESIGN NOTE: the Coach never recomputes or second-guesses scores.
// Every answer below reads from data that buildRaceSummary() already
// produced for the Races/Bankroll tabs — the same composite scores, the same
// confidence levels, the same Kelly stakes. This guarantees the Coach can
// never disagree with the rest of the app, because it has no independent
// opinion; it only narrates what's already there.
//
// HOW TO ADD AN LLM PROVIDER LATER (this groundwork is already done — see
// llmCoachProvider below, which IS the LLM-backed provider in active use):
// 1. buildCoachContext(card, bankroll) assembles every race's full summary,
//    odds history, and bankroll state into one plain JSON-able object.
// 2. serializeCoachContext(context) flattens that into the compact payload
//    sent to the Netlify Function as part of an LLM prompt.
// 3. Any provider matching CoachProviderInterface (answerQuestion,
//    generateInsights) can be swapped into activeCoachProvider without the
//    chat UI, conversation history, suggested prompts, or insight cards
//    needing to change at all.
// ============================================================================

import { KELLY_MAX_PCT_OF_BANKROLL, buildRaceSummary, formatMovementSummary } from "./scoring.js";
import { decideBet, BET_DECISION_RULES } from "./betDecision.js";


export const CoachProviderInterface = {
  // name: string shown in the UI
  // async answerQuestion(context, question, history) => Promise<{ text: string }>
  // async generateInsights(context) => Promise<CoachInsight[]>
};

// Builds one plain-data snapshot of everything the Coach can reason about,
// for the currently active card. This is intentionally the single seam an
// LLM provider would serialize into a prompt later — keep it complete and
// flat rather than scattering context-gathering across the UI layer.
export function buildCoachContext(card, bankroll, preferences) {
  const raceSummaries = card.races.map((race) => {
    const summary = buildRaceSummary(race, bankroll);
    // betDecision is the new, stricter post-scoring filter (see
    // betDecision.js) — attached here so insights can use it, without
    // touching anything inside summary itself or how buildRaceSummary works.
    const betDecision = decideBet(summary, race);
    return { race, summary, betDecision };
  });
  return { card, bankroll, raceSummaries, preferences: preferences || null };
}

// Converts the rich context object above into a compact, flat JSON structure
// suitable for sending to an LLM as part of a prompt. Keeps only the fields
// actually useful for answering questions — full odds history (not just the
// latest), composite scores and sub-scores, pace/chaos/confidence reads, and
// bet/pass recommendations with Kelly sizing. This is the exact payload the
// coach.js Netlify Function forwards to OpenAI/Anthropic; keeping it here
// (rather than in the function) means the rule-based and LLM providers stay
// guaranteed-consistent with each other, since they're describing the same
// underlying numbers.
export function serializeCoachContext(context) {
  return {
    track: context.card.track,
    date: context.card.date,
    bankroll: {
      startingBankroll: context.bankroll.startingBankroll || null,
      unitSize: context.bankroll.unitSize || null,
    },
    // Only included when the person has opted in (aiUsePreferencesInAdvice).
    // Omitting it entirely when off is deliberate — an LLM given a field
    // with empty/default values might still reference it; not sending it at
    // all is the clean way to honor an opt-out.
    userPreferences:
      context.preferences && context.preferences.aiUsePreferencesInAdvice
        ? {
            preferredTracks: context.preferences.preferredTracks,
            favoriteBetTypes: context.preferences.favoriteBetTypes,
            riskTolerance: context.preferences.riskTolerance,
            answerStyle: context.preferences.aiTone,
          }
        : null,
    races: context.raceSummaries.map(({ race, summary, betDecision }) => ({
      raceNumber: race.raceNumber,
      postTime: race.postTime || null,
      surface: race.surface || null,
      distance: race.distance || null,
      raceType: race.raceType || null,
      paceProjection: {
        label: summary.paceProjection.label,
        description: summary.paceProjection.description,
        counts: summary.paceProjection.counts,
      },
      chaos: {
        skipRace: summary.chaos.skipRace,
        level: summary.chaos.level,
        reasons: summary.chaos.reasons,
      },
      confidence: summary.confidence,
      betPass: summary.betRec.skip ? "Pass" : summary.betRec.betPass,
      betPassReason: summary.betRec.skip ? summary.chaos.reasons[0] || "Flagged to skip" : summary.betRec.betPassReason,
      // betDecision is the newer, stricter race-level call (STRONG BET /
      // BET / LEAN / PASS) — kept distinct from betPass above (which is the
      // older, looser signal) rather than replacing it, so an LLM provider
      // can see both and should defer to betDecision when they disagree.
      betDecision: betDecision
        ? {
            label: betDecision.label,
            reasonsToBet: betDecision.reasonsToBet,
            reasonsForCaution: betDecision.reasonsForCaution,
            effectiveConfidencePct: betDecision.effectiveConfidencePct,
          }
        : null,
      suggestedBets: summary.betRec.bets.map((b) => ({
        type: b.type,
        detail: b.detail,
        stake: b.stake,
        rationale: b.rationale,
        kellyFullPct: b.kelly && !b.kelly.isNegativeEdge ? b.kelly.fullKellyPct : null,
      })),
      horses: summary.scored.map((s) => ({
        programNumber: s.horse.programNumber || null,
        name: s.horse.name,
        jockey: s.horse.jockey || null,
        trainer: s.horse.trainer || null,
        mlOdds: s.horse.mlOdds || null,
        liveOdds: s.horse.liveOdds || null,
        compositeScore: Math.round(s.composite),
        subScores: {
          speedForm: Math.round(s.breakdown.speedForm),
          paceFit: Math.round(s.breakdown.paceFit),
          classFit: Math.round(s.breakdown.classFit),
          trainerJockey: Math.round(s.breakdown.trainerJockey),
          workoutsLayoff: Math.round(s.breakdown.workoutsLayoff),
          oddsValue: Math.round(s.breakdown.oddsValue),
        },
        layoff: s.layoff.label,
        workout: s.workout.label,
        oddsMovement: s.movement
          ? { direction: s.movement.direction, pctChange: Math.round(s.movement.pctChange), snapshotCount: s.movement.snapshotCount }
          : null,
        smartMoneyFlag: s.smartMoney ? s.smartMoney.strength : null,
        oddsHistory: (s.horse.oddsHistory || []).map((h) => ({
          timestamp: h.timestamp,
          mlOdds: h.mlOdds || null,
          liveOdds: h.liveOdds || null,
        })),
        isTopPick: summary.topPick && summary.topPick.horse.id === s.horse.id,
        isBestValue: summary.bestValue && summary.bestValue.horse.id === s.horse.id,
        isBestLongshot: summary.bestLongshot && summary.bestLongshot.horse.id === s.horse.id,
        isFadeFavorite: summary.fadeFavorite && summary.fadeFavorite.horse.id === s.horse.id,
      })),
    })),
  };
}

// ---- Formatting helpers shared by multiple intents -------------------------
function horseLabel(scoredEntry) {
  if (!scoredEntry) return null;
  return `#${scoredEntry.horse.programNumber || "?"} ${scoredEntry.horse.name}`;
}

function raceLabel(race) {
  return `Race ${race.raceNumber}${race.postTime ? ` (${race.postTime})` : ""}`;
}

function pct(n) {
  return `${Math.round(n)}%`;
}

// ---- Proactive insight generators ------------------------------------------
// Each returns a CoachInsight: { id, title, tone, summary, detail, raceNumbers }
// `detail` is the expandable, longer explanation shown when the person taps
// the insight card open.

export function insightBestBetsToday(ctx) {
  const bets = ctx.raceSummaries
    .filter(({ summary, betDecision }) => betDecision && (betDecision.label === "STRONG BET" || betDecision.label === "BET") && summary.topPick)
    .map(({ race, summary, betDecision }) => ({ race, summary, betDecision }));

  if (!bets.length) {
    return {
      id: "best-bets",
      title: "Best bets today",
      tone: "neutral",
      summary: "No race currently clears this app's bet bar — most cards should land here most days. That's by design: passing a marginal race protects your bankroll more than forcing an action.",
      detail: `A BET (or STRONG BET) call requires confidence at or above ${BET_DECISION_RULES.MIN_CONFIDENCE_PCT}%, a top score at or above ${BET_DECISION_RULES.MIN_TOP_SCORE} (or a very strong price edge), real separation from the second-place horse, low chaos, and solid underlying data. Add more races, refresh odds, or check back closer to post for late scratches/odds moves.`,
      raceNumbers: [],
    };
  }

  const top = bets
    .slice()
    .sort((a, b) => b.summary.topPick.composite - a.summary.topPick.composite)
    .slice(0, 3);

  const lines = top.map(
    ({ race, summary, betDecision }) => `${raceLabel(race)}: ${horseLabel(summary.topPick)} (score ${Math.round(summary.topPick.composite)}, ${betDecision.label}, ${summary.confidence.label.toLowerCase()} confidence)`
  );

  const usePrefs = ctx.preferences && ctx.preferences.aiUsePreferencesInAdvice;
  const isPreferredTrack =
    usePrefs && ctx.preferences.preferredTracks.some((t) => t.toLowerCase() === (ctx.card.track || "").toLowerCase());
  const trackNote = isPreferredTrack ? ` ${ctx.card.track} is one of your preferred tracks.` : "";

  return {
    id: "best-bets",
    title: "Best bets today",
    tone: "positive",
    summary: `${top.length} race${top.length === 1 ? "" : "s"} clear this app's stricter bet bar. Top of the list: ${horseLabel(top[0].summary.topPick)} in ${raceLabel(top[0].race)} (${top[0].betDecision.label}).${trackNote}`,
    detail: lines.join("\n"),
    raceNumbers: top.map(({ race }) => race.raceNumber),
  };
}

export function insightBestValue(ctx) {
  const valuePlays = ctx.raceSummaries
    .filter(({ summary }) => summary.bestValue && !summary.chaos.skipRace)
    .map(({ race, summary }) => ({ race, summary }));

  if (!valuePlays.length) {
    return {
      id: "best-value",
      title: "Best value horses",
      tone: "neutral",
      summary: "No horse currently shows a meaningful gap between its model score and its market price.",
      detail: "Value plays need both a decent composite score (45+) and a price longer than the model's fair odds suggest. Enter more odds data to surface these.",
      raceNumbers: [],
    };
  }

  const ranked = valuePlays.slice().sort((a, b) => b.summary.bestValue.edge - a.summary.bestValue.edge).slice(0, 3);
  const lines = ranked.map(
    ({ race, summary }) =>
      `${raceLabel(race)}: ${horseLabel(summary.bestValue)} at ${summary.bestValue.horse.liveOdds || summary.bestValue.horse.mlOdds || "—"} (+${(summary.bestValue.edge * 100).toFixed(1)}pt edge)`
  );

  return {
    id: "best-value",
    title: "Best value horses",
    tone: "positive",
    summary: `${horseLabel(ranked[0].summary.bestValue)} in ${raceLabel(ranked[0].race)} shows the biggest gap between model score and market price today.`,
    detail: lines.join("\n"),
    raceNumbers: ranked.map(({ race }) => race.raceNumber),
  };
}

export function insightVulnerableFavorites(ctx) {
  const fades = ctx.raceSummaries
    .filter(({ summary }) => summary.fadeFavorite)
    .map(({ race, summary }) => ({ race, summary }));

  if (!fades.length) {
    return {
      id: "vulnerable-favorites",
      title: "Vulnerable favorites",
      tone: "neutral",
      summary: "No favorite currently looks notably overbet relative to its score.",
      detail: "A favorite gets flagged here when it's the shortest-priced horse in the race but its composite score sits below 55-60, suggesting the price is built on name recognition rather than current form.",
      raceNumbers: [],
    };
  }

  const lines = fades.map(
    ({ race, summary }) =>
      `${raceLabel(race)}: ${horseLabel(summary.fadeFavorite)} at ${summary.fadeFavorite.horse.liveOdds || summary.fadeFavorite.horse.mlOdds || "—"} only scores ${Math.round(summary.fadeFavorite.composite)}`
  );

  return {
    id: "vulnerable-favorites",
    title: "Vulnerable favorites",
    tone: "warning",
    summary: `${fades.length} favorite${fades.length === 1 ? "" : "s"} look${fades.length === 1 ? "s" : ""} shaky today, starting with ${horseLabel(fades[0].summary.fadeFavorite)} in ${raceLabel(fades[0].race)}.`,
    detail: lines.join("\n"),
    raceNumbers: fades.map(({ race }) => race.raceNumber),
  };
}

export function insightSmartMoney(ctx) {
  const flagged = ctx.raceSummaries
    .filter(({ summary }) => summary.smartMoneyHorses && summary.smartMoneyHorses.length > 0)
    .flatMap(({ race, summary }) => summary.smartMoneyHorses.map((s) => ({ race, s })));

  if (!flagged.length) {
    return {
      id: "smart-money",
      title: "Smart money alerts",
      tone: "neutral",
      summary: "No steam detected yet — capture odds snapshots closer to post time to surface movement.",
      detail: "Smart-money flags need at least two odds snapshots per horse to detect movement. This is built from odds you capture manually, not a live feed.",
      raceNumbers: [],
    };
  }

  const lines = flagged.map(
    ({ race, s }) => `${raceLabel(race)}: ${horseLabel(s)} — ${s.smartMoney.strength} signal, ${formatMovementSummary(s.movement)}`
  );

  return {
    id: "smart-money",
    title: "Smart money alerts",
    tone: "info",
    summary: `${flagged.length} horse${flagged.length === 1 ? "" : "s"} showing real odds movement worth a second look.`,
    detail: lines.join("\n"),
    raceNumbers: [...new Set(flagged.map(({ race }) => race.raceNumber))],
  };
}

export function insightPaceAnalysis(ctx) {
  const shaped = ctx.raceSummaries.map(({ race, summary }) => ({ race, shape: summary.paceProjection }));
  const contested = shaped.filter((s) => s.shape.shape === "speed_duel" || s.shape.shape === "contested");

  const lines = shaped
    .filter((s) => s.shape.total > 0)
    .map(({ race, shape }) => `${raceLabel(race)}: ${shape.label}`);

  return {
    id: "pace-analysis",
    title: "Pace analysis",
    tone: contested.length ? "info" : "neutral",
    summary: contested.length
      ? `${contested.length} race${contested.length === 1 ? "" : "s"} project a contested or speed-duel pace — closers get a boost there.`
      : "Most races today project a fairly clean pace shape — no major closer's-race setups.",
    detail: lines.join("\n") || "No races with horses entered yet.",
    raceNumbers: contested.map(({ race }) => race.raceNumber),
  };
}

// Builds a single multi-race ticket suggestion (Pick 3/4/5 style) by taking
// the top-ranked horse(s) per race across a contiguous run of races, using
// confidence to decide whether to single or spread in any given leg.
function buildSequentialPick(ctx, legCount, startRaceNumber) {
  const sorted = ctx.raceSummaries.slice().sort((a, b) => a.race.raceNumber - b.race.raceNumber);
  const startIdx = startRaceNumber
    ? sorted.findIndex(({ race }) => race.raceNumber === startRaceNumber)
    : 0;
  if (startIdx === -1 || startIdx + legCount > sorted.length) return null;

  const legs = sorted.slice(startIdx, startIdx + legCount).map(({ race, summary }) => {
    if (summary.chaos.skipRace || !summary.scored.length) {
      return { race, horses: [], note: "Skip-flagged — consider using the field (ALL) or avoiding this ticket." };
    }
    const useSingle = summary.confidence.label === "High";
    const horses = useSingle ? summary.scored.slice(0, 1) : summary.scored.slice(0, 2);
    return { race, horses, note: useSingle ? "Single — high confidence" : "Spread two — confidence not high enough to single" };
  });

  return legs;
}

export function insightSequentialPicks(ctx) {
  const sorted = ctx.raceSummaries.slice().sort((a, b) => a.race.raceNumber - b.race.raceNumber);
  if (sorted.length < 3) {
    return {
      id: "sequential-picks",
      title: "Pick 3 / 4 / 5 suggestions",
      tone: "neutral",
      summary: "Need at least 3 races loaded to suggest a sequential ticket.",
      detail: "Add more races to this card to build Pick 3/4/5 suggestions.",
      raceNumbers: [],
    };
  }
  const legCount = Math.min(5, sorted.length);
  const legs = buildSequentialPick(ctx, legCount, sorted[0].race.raceNumber);
  const lines = (legs || []).map(
    (leg) =>
      `${raceLabel(leg.race)}: ${leg.horses.length ? leg.horses.map(horseLabel).join(" / ") : "(skip-flagged)"} — ${leg.note}`
  );

  return {
    id: "sequential-picks",
    title: `Pick ${legCount} suggestion`,
    tone: "info",
    summary: `A ${legCount}-race sequence starting at ${raceLabel(sorted[0].race)}, singling where confidence is High and spreading where it isn't.`,
    detail: lines.join("\n"),
    raceNumbers: (legs || []).map((l) => l.race.raceNumber),
  };
}

export function insightSkipRecommendations(ctx) {
  const skips = ctx.raceSummaries.filter(({ summary }) => summary.chaos.skipRace);
  if (!skips.length) {
    return {
      id: "skip-recommendations",
      title: "Race skip recommendations",
      tone: "positive",
      summary: "No races are currently flagged to skip — the card looks playable across the board.",
      detail: "This will update automatically as you add horses, scratches, or odds movement that changes the chaos read on any race.",
      raceNumbers: [],
    };
  }
  const lines = skips.map(({ race, summary }) => `${raceLabel(race)}: ${summary.chaos.reasons[0] || "Flagged chaotic."}`);
  return {
    id: "skip-recommendations",
    title: "Race skip recommendations",
    tone: "warning",
    summary: `${skips.length} race${skips.length === 1 ? "" : "s"} flagged to skip today.`,
    detail: lines.join("\n"),
    raceNumbers: skips.map(({ race }) => race.raceNumber),
  };
}

export function insightBankrollAdvice(ctx) {
  const bankrollAmt = parseFloat(ctx.bankroll.startingBankroll) || 0;
  let totalStake = 0;
  ctx.raceSummaries.forEach(({ summary }) => {
    if (!summary.chaos.skipRace) {
      summary.betRec.bets.forEach((b) => (totalStake += Number(b.stake) || 0));
    }
  });

  const usePrefs = ctx.preferences && ctx.preferences.aiUsePreferencesInAdvice;
  const riskTolerance = usePrefs ? ctx.preferences.riskTolerance : "balanced";

  if (!bankrollAmt) {
    return {
      id: "bankroll-advice",
      title: "Bankroll advice",
      tone: "neutral",
      summary: "Set a starting bankroll on the Bankroll tab so the Coach can weigh in on sizing.",
      detail: "Without a bankroll figure, suggested bets fall back to flat unit sizing rather than Kelly-based stakes.",
      raceNumbers: [],
    };
  }

  const exposurePct = (totalStake / bankrollAmt) * 100;
  // Risk tolerance shifts where the warning/info thresholds sit — a
  // conservative person gets flagged sooner, an aggressive one has more
  // room before the same exposure is called out. The underlying stakes and
  // Kelly math never change; only the framing of how much exposure is "a lot".
  const thresholds =
    riskTolerance === "conservative" ? { warn: 60, info: 35 } :
    riskTolerance === "aggressive" ? { warn: 110, info: 80 } :
    { warn: 90, info: 60 };

  let tone = "positive";
  let summary = `Suggested stakes across this card total $${totalStake.toFixed(0)}, about ${pct(exposurePct)} of your $${bankrollAmt.toFixed(0)} bankroll — reasonable for a full card.`;
  if (exposurePct >= thresholds.warn) {
    tone = "warning";
    summary = `Suggested stakes total $${totalStake.toFixed(0)} — that's ${pct(exposurePct)} of your bankroll if you bet every suggestion. Consider passing on the lower-confidence races.`;
  } else if (exposurePct >= thresholds.info) {
    tone = "info";
    summary = `Suggested stakes total $${totalStake.toFixed(0)}, about ${pct(exposurePct)} of bankroll — on the higher side for a full card.`;
  }

  if (usePrefs && riskTolerance === "conservative" && tone === "positive") {
    summary += " That fits a conservative approach well.";
  } else if (usePrefs && riskTolerance === "aggressive" && tone === "positive" && exposurePct < thresholds.info * 0.5) {
    summary += " Given your aggressive risk setting, there may be room to look harder at the value and longshot plays today.";
  }

  return {
    id: "bankroll-advice",
    title: "Bankroll advice",
    tone,
    summary,
    detail: `Bankroll: $${bankrollAmt.toFixed(0)}. Total suggested stake: $${totalStake.toFixed(0)} (${pct(exposurePct)}). Stakes already use a quarter-Kelly fraction capped at ${(KELLY_MAX_PCT_OF_BANKROLL * 100).toFixed(0)}% of bankroll per bet where a price edge exists.${usePrefs ? ` Thresholds shown reflect your "${riskTolerance}" risk setting.` : ""}`,
    raceNumbers: [],
  };
}

export function generateAllInsights(ctx) {
  return [
    insightBestBetsToday(ctx),
    insightBestValue(ctx),
    insightVulnerableFavorites(ctx),
    insightSmartMoney(ctx),
    insightPaceAnalysis(ctx),
    insightSequentialPicks(ctx),
    insightSkipRecommendations(ctx),
    insightBankrollAdvice(ctx),
  ];
}

// ---- Natural-language question router --------------------------------------
// Lightweight keyword/intent matching today. An LLM provider would replace
// this whole function with an API call, but the CALLER (CoachChat) doesn't
// know or care which one is active.
export function routeQuestionToAnswer(ctx, question) {
  const q = question.toLowerCase();

  const findRaceNumber = () => {
    const m = q.match(/race\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };

  const raceNum = findRaceNumber();
  if (raceNum) {
    const found = ctx.raceSummaries.find(({ race }) => race.raceNumber === raceNum);
    if (!found) return `I don't have Race ${raceNum} loaded on this card.`;
    return answerAboutOneRace(found.race, found.summary, q);
  }

  if (/my preference|my profile|risk tolerance|favorite bet/.test(q)) {
    const usePrefs = ctx.preferences && ctx.preferences.aiUsePreferencesInAdvice;
    if (!usePrefs) {
      return "You haven't set up preferences yet, or you've turned off \"Use my preferences in AI advice\" in your profile. Tap the gear icon to set preferred tracks, default bankroll, favorite bet types, and risk tolerance.";
    }
    const p = ctx.preferences;
    const parts = [];
    parts.push(`Risk tolerance: ${p.riskTolerance}.`);
    if (p.preferredTracks.length) parts.push(`Preferred tracks: ${p.preferredTracks.join(", ")}.`);
    if (p.favoriteBetTypes.length) parts.push(`Favorite bet types: ${p.favoriteBetTypes.join(", ")}.`);
    if (p.defaultBankroll) parts.push(`Default bankroll: $${p.defaultBankroll}.`);
    return parts.join(" ");
  }

  if (/skip|pass|avoid|chaotic/.test(q)) {
    const insight = insightSkipRecommendations(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/value/.test(q)) {
    const insight = insightBestValue(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/favorite|fade/.test(q)) {
    const insight = insightVulnerableFavorites(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/smart money|steam|drift|movement/.test(q)) {
    const insight = insightSmartMoney(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/pace/.test(q)) {
    const insight = insightPaceAnalysis(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/pick\s*[345]|sequential|ticket/.test(q)) {
    const insight = insightSequentialPicks(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/bankroll|stake|unit|money|afford/.test(q)) {
    const insight = insightBankrollAdvice(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/best bet|top pick|who should i bet|what.*bet today/.test(q)) {
    const insight = insightBestBetsToday(ctx);
    return `${insight.summary}\n\n${insight.detail}`;
  }
  if (/confidence/.test(q)) {
    const lines = ctx.raceSummaries.map(
      ({ race, summary }) => `${raceLabel(race)}: ${summary.confidence.label} (${summary.confidence.pct}%)`
    );
    return `Confidence by race:\n\n${lines.join("\n")}`;
  }

  // Fallback: give a general-purpose summary of the whole card rather than
  // a flat "I don't understand" — keeps the Coach useful for vague asks.
  const insight = insightBestBetsToday(ctx);
  return (
    `I'm not sure exactly what you're asking, so here's a quick read on today's card: ${insight.summary}\n\n` +
    `Try asking about a specific race ("what about race 4"), value, favorites, pace, smart money, Pick 3/4/5, or bankroll.`
  );
}

function answerAboutOneRace(race, summary, q) {
  if (summary.chaos.skipRace) {
    return `${raceLabel(race)} is flagged to skip. ${summary.chaos.reasons.join(" ")}`;
  }
  if (!summary.scored.length) {
    return `${raceLabel(race)} doesn't have any horses entered yet.`;
  }
  const parts = [
    `${raceLabel(race)} — ${summary.betRec.skip ? "Pass" : summary.betRec.betPass}, ${summary.confidence.label.toLowerCase()} confidence (${summary.confidence.pct}%).`,
    `Top pick: ${horseLabel(summary.topPick)} (score ${Math.round(summary.topPick.composite)}).`,
  ];
  if (summary.bestValue) parts.push(`Best value: ${horseLabel(summary.bestValue)}.`);
  if (summary.bestLongshot) parts.push(`Longshot to watch: ${horseLabel(summary.bestLongshot)}.`);
  if (summary.fadeFavorite) parts.push(`Fade candidate: ${horseLabel(summary.fadeFavorite)}.`);
  parts.push(`Pace read: ${summary.paceProjection.label}.`);
  return parts.join(" ");
}

// ---- Rule-based Coach provider (today's implementation) --------------------
export const ruleBasedCoachProvider = {
  name: "Rule-based (scoring engine)",
  async answerQuestion(context, question /*, history */) {
    // Small artificial delay so the chat UI's "thinking" state is visible
    // and the UX doesn't feel broken when an LLM provider later takes
    // noticeably longer than this instant rule lookup.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const text = routeQuestionToAnswer(context, question);
    return { text };
  },
  async generateInsights(context) {
    return generateAllInsights(context);
  },
};

// ---- LLM-backed Coach provider (calls /netlify/functions/coach) ------------
// Sends the serialized context + question + conversation history to the
// server-side function, which itself decides whether a real LLM key is
// configured. If the function is unreachable, errors, or explicitly reports
// no key is configured, this provider falls back to the rule-based provider
// rather than showing an error — the person should never see a broken Coach,
// only ever a less-personalized one.
export const llmCoachProvider = {
  name: "LLM (via Netlify Function, with rule-based fallback)",
  async answerQuestion(context, question, history) {
    try {
      const res = await fetch("/.netlify/functions/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "answer",
          context: serializeCoachContext(context),
          question,
          history: (history || []).slice(-10), // cap context sent per request
        }),
      });

      if (!res.ok) {
        return fallbackAnswer(context, question, `Coach API returned ${res.status}`);
      }
      const data = await res.json().catch(() => null);
      if (!data || typeof data.text !== "string") {
        return fallbackAnswer(context, question, "Coach API returned an unexpected response shape");
      }
      if (data.usedFallback) {
        // The function itself had no API key configured and used its own
        // rule-based path server-side — surface that the same way a
        // client-side fallback would, but trust their text since it came
        // from the same engine logic mirrored server-side.
        return { text: data.text, source: data.source || "fallback" };
      }
      return { text: data.text, source: data.source || "llm" };
    } catch (networkErr) {
      return fallbackAnswer(context, question, `Network error reaching Coach API: ${networkErr.message}`);
    }
  },
  async generateInsights(context) {
    // Proactive insights stay rule-based even in LLM mode — they're meant to
    // be fast, deterministic, and always available the instant a card loads,
    // not dependent on a network round-trip or LLM latency. The LLM is used
    // for conversational Q&A, where its strength (flexible phrasing, handling
    // questions the rule router doesn't recognize) actually matters.
    return generateAllInsights(context);
  },
};

function fallbackAnswer(context, question, reason) {
  console.warn("Coach falling back to rule-based answer:", reason);
  const text = routeQuestionToAnswer(context, question);
  return { text, source: "fallback", fallbackReason: reason };
}

// activeCoachProvider is the swap point for the Coach's brain. llmCoachProvider
// is the default — it always attempts the real API first and transparently
// falls back to rule-based answers on any failure, so there is no separate
// "fallback mode" to toggle; degrading gracefully is just what it does.
export const activeCoachProvider = llmCoachProvider;
