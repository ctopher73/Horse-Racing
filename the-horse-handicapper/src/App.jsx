// ============================================================================
// LONE STAR PARK BETTING INTELLIGENCE PLATFORM — single-file React app
// v2: real-time-style odds tracking (manual snapshot), movement alerts,
// smart-money heuristic, ROI inputs, layoff/workout/pace engines, Kelly sizing.
// ============================================================================
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import "./styles.css";
import { cryptoId, clamp, slugify, formatDateLong, formatTimeShort } from "./lib/utils.js";
import {
  WEIGHTS,
  TIERS,
  KELLY_FRACTION_CAP,
  KELLY_MAX_PCT_OF_BANKROLL,
  KELLY_MIN_TRACKED_BETS_FOR_CONFIDENCE,
  parseOddsToDecimal,
  formatOddsFraction,
  currentDecOdds,
  snapshotRaceOdds,
  oddsMovement,
  formatMovementSummary,
  analyzeLayoff,
  analyzeWorkout,
  projectPaceShape,
  computeRaceScores,
  tierFor,
  kellyStake,
  buildRaceSummary,
} from "./lib/scoring.js";
import {
  buildCoachContext,
  generateAllInsights,
  insightBestBetsToday,
  insightBestValue,
  insightVulnerableFavorites,
  insightSmartMoney,
  insightPaceAnalysis,
  insightSequentialPicks,
  insightSkipRecommendations,
  insightBankrollAdvice,
  activeCoachProvider,
} from "./lib/coach.js";
import {
  blankHorse,
  blankRace,
  blankCard,
  duplicateCard,
  loadState,
  saveState,
  csvToRaces,
  exportSampleCSV,
  BET_TYPES,
  RISK_TOLERANCES,
  defaultPreferences,
  loadPreferences,
  savePreferences,
} from "./lib/storage.js";
import { activeProvider } from "./lib/providers.js";
import ImportEquibasePDF from "./components/ImportEquibasePDF.jsx";
import { decideBet, BET_DECISION_RULES } from "./lib/betDecision.js";
import {
  loadBetTrackingHistory,
  saveBetTrackingHistory,
  raceTrackingKey,
  blankTrackingRecord,
  recordFinishOrder,
  removeTrackingRecord,
  compareRecordToSnapshot,
  computeTrackingStats,
  computeApproximateROI,
} from "./lib/betTracking.js";

// ---------------------------------------------------------------------------
// BRAND — The Horse Handicapper logo (horseshoe + horse head, inline SVG so
// it stays crisp at any size and themes with the app's CSS variables).
// ---------------------------------------------------------------------------
function HorseHandicapperLogo({ size = 32 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="brand-logo-svg"
      role="img"
      aria-label="The Horse Handicapper"
    >
      {/* Horseshoe, open end up, arcing behind the horse head */}
      <path
        d="M32 6C19.85 6 10 15.85 10 28v8a4 4 0 0 0 8 0v-8c0-7.73 6.27-14 14-14s14 6.27 14 14v8a4 4 0 0 0 8 0v-8C54 15.85 44.15 6 32 6Z"
        fill="var(--brand-gold)"
      />
      {/* Horseshoe nail studs */}
      <circle cx="14.5" cy="22" r="1.6" fill="var(--brand-felt)" />
      <circle cx="18.5" cy="14.5" r="1.6" fill="var(--brand-felt)" />
      <circle cx="49.5" cy="22" r="1.6" fill="var(--brand-felt)" />
      <circle cx="45.5" cy="14.5" r="1.6" fill="var(--brand-felt)" />
      {/* Horse head silhouette, facing left, nested inside the horseshoe arc */}
      <path
        d="M33.5 20c-3.6 0-6.9 1.6-9.1 4.2l-3.6-1.1a1.4 1.4 0 0 0-1.6 2l1.9 3.4-2.6 2a1.4 1.4 0 0 0 .3 2.4l3 1.1c-.2 1-.3 2-.3 3 0 5.6 3.9 10.3 9.2 11.6.4 1.5 1.8 2.6 3.4 2.6h7.8a1.6 1.6 0 0 0 1.6-1.8l-.5-3.4c2.6-1.9 4.3-5 4.3-8.5v-3.6c0-7.2-5.8-13-13-13.9Z"
        fill="var(--brand-green)"
      />
      <circle cx="36" cy="29.5" r="1.5" fill="var(--brand-gold)" />
      {/* Mane */}
      <path
        d="M30 21.5c-1.8.6-3.4 1.7-4.6 3.1 1.6-.3 3.3-.2 4.9.3"
        stroke="var(--brand-gold)"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

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

function EmptyStateIllustration({ kind }) {
  const common = { width: 88, height: 64, viewBox: "0 0 88 64", fill: "none", xmlns: "http://www.w3.org/2000/svg" };
  if (kind === "horses") {
    return (
      <svg {...common} aria-hidden="true">
        <ellipse cx="44" cy="54" rx="34" ry="6" fill="var(--felt-line-strong)" />
        <path d="M20 48c0-14 8-26 18-26 3 0 5 1 7 3 6-3 12-2 15 3 4 6 2 14-3 18-2 1.5-5 2-8 2H28c-4.5 0-8-3.5-8-8Z" fill="var(--gold-dim)" opacity="0.5" />
        <path d="M52 22c1.5-3 4-5 7-5.5-.5 2.5-1.5 4.5-3 6" stroke="var(--gold-dim)" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
        <circle cx="56" cy="27" r="1.6" fill="var(--text-on-felt-faint)" />
      </svg>
    );
  }
  if (kind === "cards") {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="18" y="10" width="40" height="28" rx="4" fill="var(--felt-line-strong)" transform="rotate(-6 38 24)" />
        <rect x="26" y="18" width="44" height="30" rx="5" fill="var(--gold-dim)" opacity="0.55" />
        <line x1="33" y1="27" x2="63" y2="27" stroke="var(--felt)" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
        <line x1="33" y1="33" x2="55" y2="33" stroke="var(--felt)" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
      </svg>
    );
  }
  if (kind === "chat") {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="14" y="12" width="44" height="30" rx="10" fill="var(--gold-dim)" opacity="0.5" />
        <path d="M26 42l-4 10 12-7" fill="var(--gold-dim)" opacity="0.5" />
        <circle cx="28" cy="27" r="2.5" fill="var(--felt)" opacity="0.5" />
        <circle cx="36" cy="27" r="2.5" fill="var(--felt)" opacity="0.5" />
        <circle cx="44" cy="27" r="2.5" fill="var(--felt)" opacity="0.5" />
        <rect x="40" y="8" width="34" height="24" rx="8" fill="var(--felt-line-strong)" />
      </svg>
    );
  }
  // default: "races" — a simple post-position board
  return (
    <svg {...common} aria-hidden="true">
      <rect x="12" y="14" width="64" height="36" rx="6" fill="var(--felt-line-strong)" />
      <rect x="18" y="20" width="14" height="14" rx="3" fill="var(--gold-dim)" opacity="0.6" />
      <rect x="36" y="20" width="14" height="14" rx="3" fill="var(--gold-dim)" opacity="0.4" />
      <rect x="54" y="20" width="14" height="14" rx="3" fill="var(--gold-dim)" opacity="0.25" />
      <rect x="18" y="38" width="50" height="4" rx="2" fill="var(--felt-line-strong)" />
    </svg>
  );
}

function EmptyState({ title, body, action, illustration }) {
  return (
    <div className="empty-state">
      {illustration && (
        <div className="empty-state-illustration">
          <EmptyStateIllustration kind={illustration} />
        </div>
      )}
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
        <input value={horse.name} onChange={set("name")} placeholder="Northern Star" />
      </label>

      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Jockey</span>
          <input value={horse.jockey} onChange={set("jockey")} placeholder="J. Ortiz" />
        </label>
        <label className="field">
          <span>Trainer</span>
          <input value={horse.trainer} onChange={set("trainer")} placeholder="M. Casse" />
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
function HorseRow({ result, rank, onEdit, onAskAI, raceNumber }) {
  const { horse, composite, breakdown, decOdds, movement, smartMoney } = result;
  const tier = tierFor(composite);
  return (
    <div className="horse-row">
      <button className="horse-row-clickzone" onClick={onEdit}>
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
      <button
        className="ask-ai-btn ask-ai-btn-horse"
        onClick={(e) => {
          e.stopPropagation();
          onAskAI(`Tell me about #${horse.programNumber || "?"} ${horse.name} in Race ${raceNumber}.`);
        }}
      >
        Ask AI
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RACE SUMMARY CARD (used in Dashboard)
// ---------------------------------------------------------------------------
function RaceSummaryCard({ race, summary, betDecision, onOpen, onAskAI }) {
  const { topPick, bestValue, bestLongshot, fadeFavorite, chaos, confidence, betRec, smartMoneyHorses } = summary;
  return (
    <div className="race-card">
      <button className="race-card-clickzone" onClick={onOpen}>
        <div className="race-card-top">
          <div className="race-card-num">R{race.raceNumber}</div>
          <div className="race-card-meta">
            <div className="race-card-time">{race.postTime || "Post TBA"}</div>
            <div className="race-card-cond">
              {race.surface || "Dirt"} · {race.distance || "—"}
            </div>
          </div>
          <Pill tone={betDecisionTone(betDecision?.label)}>{betDecision?.label || (chaos.skipRace ? "SKIP" : betRec.betPass.toUpperCase())}</Pill>
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

      <button
        className="ask-ai-btn ask-ai-btn-race"
        onClick={(e) => {
          e.stopPropagation();
          onAskAI(`What about Race ${race.raceNumber}?`);
        }}
      >
        Ask AI about this race
      </button>
    </div>
  );
}

function betDecisionTone(label) {
  if (label === "STRONG BET") return "bet";
  if (label === "BET") return "bet";
  if (label === "LEAN") return "value";
  return "default"; // PASS, or unknown
}

// ---------------------------------------------------------------------------
// RACE DETAIL VIEW
// ---------------------------------------------------------------------------
function RaceDetail({ race, summary, betDecision, card, trackingHistory, onRecordFinish, onDeleteTrackingRecord, onUpdateRace, onAddHorse, onEditHorse, onSnapshotOdds, bankroll, onAskAI }) {
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

      <button className="ask-ai-btn ask-ai-btn-race-detail" onClick={() => onAskAI(`What about Race ${race.raceNumber}?`)}>
        Ask AI about this race
      </button>

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

      <div className={`card bet-pass-banner bet-pass-${slugify(betDecision.label)}`}>
        <div className="bet-pass-label">{betDecision.label}</div>
        <div className="bet-pass-reason">
          {betDecision.label === "PASS"
            ? betDecision.reasonsForCaution[0] || "Too many caution flags to bet this race."
            : betDecision.reasonsToBet[0] || betRec.betPassReason}
        </div>
        {(betDecision.reasonsToBet.length > 0 || betDecision.reasonsForCaution.length > 0) && (
          <div className="bet-decision-reasons">
            {betDecision.reasonsToBet.length > 0 && (
              <div className="bet-decision-reason-group">
                <div className="bet-decision-reason-heading bet-decision-reason-heading-positive">Reasons to bet</div>
                <ul className="bet-decision-reason-list">
                  {betDecision.reasonsToBet.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {betDecision.reasonsForCaution.length > 0 && (
              <div className="bet-decision-reason-group">
                <div className="bet-decision-reason-heading bet-decision-reason-heading-caution">Reasons to be cautious</div>
                <ul className="bet-decision-reason-list">
                  {betDecision.reasonsForCaution.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="bet-decision-meta muted-text">
          Effective confidence after data-quality and caution adjustments: {betDecision.effectiveConfidencePct}%
        </div>
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
        <div className="card-title-row">
          <span className="card-title">Suggested bets</span>
          {!chaos.skipRace && betDecision.label === "PASS" && (
            <span className="bet-list-pass-note">This app's decision: PASS — see above</span>
          )}
        </div>
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
                      Kelly (informational): {b.kelly.fullKellyPct.toFixed(1)}% full · using {(KELLY_FRACTION_CAP * 100).toFixed(1)}% fraction,
                      capped at {(KELLY_MAX_PCT_OF_BANKROLL * 100).toFixed(0)}% of bankroll. Not a confident stake size — the app
                      doesn't have enough tracked race history yet to calibrate this number against real results.
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
              <HorseRow key={r.horse.id} result={r} rank={i + 1} onEdit={() => onEditHorse(r.horse)} onAskAI={onAskAI} raceNumber={race.raceNumber} />
            ))}
          </div>
        ) : (
          <EmptyState
            illustration="horses"
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

      <RaceResultTracker
        race={race}
        card={card}
        summary={summary}
        betDecision={betDecision}
        trackingHistory={trackingHistory}
        onRecordFinish={onRecordFinish}
        onDeleteTrackingRecord={onDeleteTrackingRecord}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// POST-RACE RESULT TRACKING
// ---------------------------------------------------------------------------
function RaceResultTracker({ race, card, summary, betDecision, trackingHistory, onRecordFinish, onDeleteTrackingRecord }) {
  const key = raceTrackingKey(card, race);
  const existing = trackingHistory.records.find((r) => r.key === key) || null;
  const [finishInput, setFinishInput] = useState(existing ? existing.finishOrder.join(", ") : "");
  const [editing, setEditing] = useState(!existing);

  const comparison = existing ? compareRecordToSnapshot(existing) : null;

  const handleSave = () => {
    const order = finishInput.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!order.length) return;
    onRecordFinish(race, order);
    setEditing(false);
  };

  return (
    <div className="card race-result-tracker">
      <div className="card-title-row">
        <span className="card-title">Race result</span>
        {existing && !editing && (
          <button className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>

      {!existing || editing ? (
        <>
          <p className="muted-text">
            Once this race is official, enter the finish order (program numbers, winner first) to compare it
            against the top pick, best value, and suggested bets — and build a real track record for this app.
          </p>
          <label className="field">
            <span>Finish order (e.g. "4, 1, 7")</span>
            <input
              value={finishInput}
              onChange={(e) => setFinishInput(e.target.value)}
              placeholder="Winner first, then 2nd, 3rd…"
            />
          </label>
          <button className="btn btn-block" onClick={handleSave}>Save result</button>
        </>
      ) : (
        <>
          <div className="race-result-finish">
            Finish: {existing.finishOrder.map((p, i) => `${i + 1}. #${p}`).join("  ")}
          </div>
          <div className="race-result-comparison">
            <div className={`race-result-row ${comparison.topPickWon ? "race-result-hit" : "race-result-miss"}`}>
              <span>Top pick</span>
              <span>{comparison.topPickWon == null ? "—" : comparison.topPickWon ? "Won ✓" : "Did not win"}</span>
            </div>
            <div className={`race-result-row ${comparison.bestValueWon ? "race-result-hit" : "race-result-miss"}`}>
              <span>Best value</span>
              <span>{comparison.bestValueWon == null ? "No value play" : comparison.bestValueWon ? "Won ✓" : "Did not win"}</span>
            </div>
            {comparison.suggestedBetHits.filter((h) => h.hit !== null).map((h, i) => (
              <div className={`race-result-row ${h.hit ? "race-result-hit" : "race-result-miss"}`} key={i}>
                <span>{h.type} bet</span>
                <span>{h.hit ? "Hit ✓" : "Missed"}</span>
              </div>
            ))}
          </div>
          <div className="race-result-decision-note muted-text">
            This app's call at the time: {existing.snapshot.betDecisionLabel || "—"}
            {existing.snapshot.betDecisionLabel === "PASS" && comparison.topPickWon
              ? " (passed, and the top pick would have won — worth reviewing, but one race isn't a pattern)."
              : ""}
            {existing.snapshot.betDecisionLabel && existing.snapshot.betDecisionLabel !== "PASS" && comparison.topPickWon === false
              ? " (recommended a bet, and the top pick didn't win — this is exactly what tracking is for)."
              : ""}
          </div>
          <button className="btn btn-small btn-ghost" onClick={() => onDeleteTrackingRecord(key)}>Remove this result</button>
        </>
      )}
    </div>
  );
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
// PREFERENCES SCREEN — user profile: preferred tracks, default bankroll,
// favorite bet types, risk tolerance, AI preference settings. Persisted to
// its own localStorage key, independent of card data, and read by the AI
// (see buildCoachContext / serializeCoachContext) to tailor advice.
// ---------------------------------------------------------------------------
function PreferencesScreen({ preferences, onChange, onClose }) {
  const [newTrack, setNewTrack] = useState("");

  const update = (patch) => onChange({ ...preferences, ...patch });

  const addPreferredTrack = () => {
    const track = newTrack.trim();
    if (!track) return;
    if (preferences.preferredTracks.includes(track)) {
      setNewTrack("");
      return;
    }
    update({ preferredTracks: [...preferences.preferredTracks, track] });
    setNewTrack("");
  };

  const removePreferredTrack = (track) => {
    update({ preferredTracks: preferences.preferredTracks.filter((t) => t !== track) });
  };

  const toggleBetType = (type) => {
    const has = preferences.favoriteBetTypes.includes(type);
    update({
      favoriteBetTypes: has
        ? preferences.favoriteBetTypes.filter((t) => t !== type)
        : [...preferences.favoriteBetTypes, type],
    });
  };

  return (
    <div className="preferences-screen">
      <div className="preferences-header">
        <div className="preferences-title">Your Profile</div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="card">
        <div className="card-title">Preferred tracks</div>
        <p className="muted-text">Tracks you follow most. The AI will mention these by name when relevant.</p>
        <div className="form-grid form-grid-2">
          <input
            value={newTrack}
            onChange={(e) => setNewTrack(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPreferredTrack(); } }}
            placeholder="e.g. Churchill Downs"
          />
          <button className="btn btn-small" onClick={addPreferredTrack}>+ Add</button>
        </div>
        {preferences.preferredTracks.length > 0 ? (
          <div className="pref-tag-list">
            {preferences.preferredTracks.map((track) => (
              <span className="pref-tag" key={track}>
                {track}
                <button className="pref-tag-remove" onClick={() => removePreferredTrack(track)} aria-label={`Remove ${track}`}>✕</button>
              </span>
            ))}
          </div>
        ) : (
          <p className="muted-text" style={{ marginTop: 8 }}>No preferred tracks added yet.</p>
        )}
      </div>

      <div className="card">
        <div className="card-title">Default bankroll</div>
        <p className="muted-text">Pre-fills the Bankroll tab's starting bankroll whenever you create a new race card.</p>
        <label className="field">
          <span>Default starting bankroll ($)</span>
          <input
            value={preferences.defaultBankroll}
            onChange={(e) => update({ defaultBankroll: e.target.value })}
            inputMode="decimal"
            placeholder="200"
          />
        </label>
      </div>

      <div className="card">
        <div className="card-title">Favorite bet types</div>
        <p className="muted-text">The AI will lean toward mentioning these bet types first when suggesting plays.</p>
        <div className="pref-chip-grid">
          {BET_TYPES.map((type) => {
            const active = preferences.favoriteBetTypes.includes(type);
            return (
              <button
                key={type}
                className={`pref-chip ${active ? "pref-chip-active" : ""}`}
                onClick={() => toggleBetType(type)}
              >
                {type}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Risk tolerance</div>
        <p className="muted-text">Shapes how the AI frames its advice — this does not change the underlying scoring math.</p>
        <div className="risk-option-list">
          {RISK_TOLERANCES.map((opt) => (
            <button
              key={opt.value}
              className={`risk-option ${preferences.riskTolerance === opt.value ? "risk-option-active" : ""}`}
              onClick={() => update({ riskTolerance: opt.value })}
            >
              <div className="risk-option-label">{opt.label}</div>
              <div className="risk-option-desc">{opt.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">AI preferences</div>
        <label className="field">
          <span>Answer style</span>
          <select value={preferences.aiTone} onChange={(e) => update({ aiTone: e.target.value })}>
            <option value="direct">Direct — short, confident answers</option>
            <option value="detailed">Detailed — more explanation per answer</option>
            <option value="concise">Concise — as brief as possible</option>
          </select>
        </label>
        <label className="field field-scratch">
          <span>Use my preferences in AI advice</span>
          <input
            type="checkbox"
            checked={preferences.aiUsePreferencesInAdvice}
            onChange={(e) => update({ aiUsePreferencesInAdvice: e.target.checked })}
          />
        </label>
        <p className="muted-text">
          When on, The Horse Handicapper AI factors your preferred tracks, favorite bet types, and risk
          tolerance into how it phrases suggestions. It never changes the underlying scores — only the framing.
        </p>
      </div>
    </div>
  );
}

function RaceCardsScreen({ cards, activeCardId, onCreateCard, onSwitchCard, onDeleteCard, onDuplicateCard }) {
  const [newTrack, setNewTrack] = useState("");
  const [newDate, setNewDate] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [duplicatingId, setDuplicatingId] = useState(null);
  const [duplicateDate, setDuplicateDate] = useState("");

  const sortedCards = useMemo(
    () => [...cards].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [cards]
  );

  const handleCreate = () => {
    const track = newTrack.trim() || DEFAULT_TRACK;
    const date = newDate.trim() || new Date().toISOString().slice(0, 10);
    onCreateCard(track, date);
    setNewTrack("");
    setNewDate("");
  };

  const startDuplicate = (card) => {
    setDuplicatingId(card.id);
    setDuplicateDate(card.date);
  };

  const confirmDuplicate = (cardId) => {
    onDuplicateCard(cardId, duplicateDate);
    setDuplicatingId(null);
    setDuplicateDate("");
  };

  return (
    <div className="race-cards-screen">
      <div className="card">
        <div className="card-title">New race card</div>
        <p className="muted-text">Create a card for a specific track and date. You can hold as many as you like.</p>
        <div className="form-grid form-grid-2">
          <label className="field">
            <span>Track</span>
            <input value={newTrack} onChange={(e) => setNewTrack(e.target.value)} placeholder="e.g. Churchill Downs" />
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </label>
        </div>
        <button className="btn btn-block" onClick={handleCreate}>+ Create race card</button>
      </div>

      <div className="card">
        <div className="card-title">Saved race cards ({cards.length})</div>
        <div className="race-cards-list">
          {sortedCards.map((c) => {
            const isActive = c.id === activeCardId;
            const totalHorses = c.races.reduce((sum, r) => sum + r.horses.length, 0);
            return (
              <div className={`race-card-list-row ${isActive ? "race-card-list-row-active" : ""}`} key={c.id}>
                <button className="race-card-list-main" onClick={() => onSwitchCard(c.id)}>
                  <div className="race-card-list-title">
                    {c.track}
                    {isActive && <span className="pill pill-bet" style={{ marginLeft: 8 }}>ACTIVE</span>}
                  </div>
                  <div className="race-card-list-sub">
                    {formatDateLong(c.date)} · {c.races.length} race{c.races.length === 1 ? "" : "s"} · {totalHorses} horse{totalHorses === 1 ? "" : "s"}
                  </div>
                </button>
                <div className="race-card-list-actions">
                  {duplicatingId === c.id ? (
                    <div className="race-card-duplicate-row">
                      <input type="date" value={duplicateDate} onChange={(e) => setDuplicateDate(e.target.value)} />
                      <button className="btn btn-small" onClick={() => confirmDuplicate(c.id)}>Copy</button>
                      <button className="icon-btn" onClick={() => setDuplicatingId(null)} aria-label="Cancel">✕</button>
                    </div>
                  ) : confirmDeleteId === c.id ? (
                    <div className="race-card-duplicate-row">
                      <span className="muted-text" style={{ fontSize: 12 }}>Delete this card?</span>
                      <button className="btn btn-small btn-danger-solid" onClick={() => { onDeleteCard(c.id); setConfirmDeleteId(null); }}>Delete</button>
                      <button className="icon-btn" onClick={() => setConfirmDeleteId(null)} aria-label="Cancel">✕</button>
                    </div>
                  ) : (
                    <>
                      <button className="btn btn-ghost btn-small" onClick={() => startDuplicate(c)}>Duplicate</button>
                      <button className="btn btn-ghost btn-small race-card-delete-btn" onClick={() => setConfirmDeleteId(c.id)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {cards.length === 1 && (
          <p className="muted-text" style={{ marginTop: 10 }}>
            Duplicating a card is useful for a track that races on a regular schedule — copy last week's card,
            update the date, and re-enter or re-import the new field.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DASHBOARD VIEW
// ---------------------------------------------------------------------------
function Dashboard({ card, summaries, betDecisions, onOpenRace, onAddRace, onAskAI }) {
  const stats = useMemo(() => {
    const raceCount = card.races.length;
    let betCount = 0;
    let skipCount = 0;
    let horseCount = 0;
    card.races.forEach((race) => {
      const s = summaries[race.id];
      const d = betDecisions?.[race.id];
      horseCount += race.horses.filter((h) => !h.scratched && h.name && h.name.trim()).length;
      if (!s) return;
      if (d) {
        if (d.label === "PASS") skipCount++;
        else if (d.label === "STRONG BET" || d.label === "BET") betCount++;
      } else if (s.chaos.skipRace) skipCount++;
      else if (s.betRec.betPass !== "Pass") betCount++;
    });
    return { raceCount, betCount, skipCount, horseCount };
  }, [card, summaries, betDecisions]);

  return (
    <div className="dashboard">
      <div className="dashboard-hero">
        <div className="dashboard-hero-top">
          <div className="dashboard-track">{card.track}</div>
          <div className="dashboard-date">{formatDateLong(card.date)}</div>
        </div>
        {stats.raceCount > 0 && (
          <div className="dashboard-stat-row">
            <div className="dashboard-stat">
              <span className="dashboard-stat-num">{stats.raceCount}</span>
              <span className="dashboard-stat-label">Race{stats.raceCount === 1 ? "" : "s"}</span>
            </div>
            <div className="dashboard-stat">
              <span className="dashboard-stat-num dashboard-stat-num-positive">{stats.betCount}</span>
              <span className="dashboard-stat-label">Bet signal{stats.betCount === 1 ? "" : "s"}</span>
            </div>
            <div className="dashboard-stat">
              <span className="dashboard-stat-num dashboard-stat-num-warning">{stats.skipCount}</span>
              <span className="dashboard-stat-label">Skip flag{stats.skipCount === 1 ? "" : "s"}</span>
            </div>
            <div className="dashboard-stat">
              <span className="dashboard-stat-num">{stats.horseCount}</span>
              <span className="dashboard-stat-label">Horse{stats.horseCount === 1 ? "" : "s"}</span>
            </div>
          </div>
        )}
      </div>

      {card.races.length === 0 ? (
        <EmptyState
          illustration="races"
          title="No races yet"
          body="Add your first race to start scoring horses, or import a CSV from the Data tab."
          action={<button className="btn" onClick={onAddRace}>+ Add first race</button>}
        />
      ) : (
        <div className="race-card-list">
          {card.races.map((race) => (
            <RaceSummaryCard
              key={race.id}
              race={race}
              summary={summaries[race.id]}
              betDecision={betDecisions?.[race.id]}
              onOpen={() => onOpenRace(race.id)}
              onAskAI={onAskAI}
            />
          ))}
          <button className="add-race-card" onClick={onAddRace}>
            <span className="add-race-plus">+</span>
            <span>Add race</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// COACH TAB — chat interface over the Coach engine
// ---------------------------------------------------------------------------
const SUGGESTED_PROMPTS = [
  "What's the best bet today?",
  "Any vulnerable favorites?",
  "Show me value horses",
  "Any smart money moving?",
  "What's the pace look like?",
  "Suggest a Pick 4",
  "Any races to skip?",
  "How's my bankroll looking?",
  "What are my preferences?",
];

function CoachInsightCard({ insight, onAskAbout }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`coach-insight-card coach-insight-${insight.tone}`}>
      <button className="coach-insight-header" onClick={() => setExpanded((e) => !e)}>
        <span className="coach-insight-title">{insight.title}</span>
        <span className="coach-insight-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      <div className="coach-insight-summary">{insight.summary}</div>
      {expanded && (
        <div className="coach-insight-detail">
          {insight.detail.split("\n").map((line, i) => (
            <div key={i} className="coach-insight-detail-line">{line}</div>
          ))}
          <button className="coach-insight-ask-btn" onClick={() => onAskAbout(insight.title)}>
            Ask The Horse Handicapper AI about this →
          </button>
        </div>
      )}
    </div>
  );
}

// Today's Briefing — a fixed, always-visible-first summary of the six things
// explicitly requested: best bet, best value, vulnerable favorite, races to
// skip, bankroll exposure, and Pick 3/4 ideas. Distinct from the scrollable
// insights grid below it (which covers the full insight set including smart
// money and pace) — the briefing is the "read this first" digest.
function TodaysBriefing({ context }) {
  const bestBets = insightBestBetsToday(context);
  const bestValue = insightBestValue(context);
  const vulnerable = insightVulnerableFavorites(context);
  const skips = insightSkipRecommendations(context);
  const bankrollAdvice = insightBankrollAdvice(context);
  const picks = insightSequentialPicks(context);

  const rows = [
    { label: "Best bet", insight: bestBets },
    { label: "Best value", insight: bestValue },
    { label: "Vulnerable favorite", insight: vulnerable },
    { label: "Races to skip", insight: skips },
    { label: "Bankroll exposure", insight: bankrollAdvice },
    { label: "Pick 3/4 idea", insight: picks },
  ];

  return (
    <div className="briefing-card">
      <div className="briefing-header">
        <span className="briefing-title">Today's Briefing</span>
        <span className="data-source-tag">{context.card.track} · {formatDateLong(context.card.date)}</span>
      </div>
      <div className="briefing-grid">
        {rows.map((row) => (
          <div className={`briefing-row briefing-row-${row.insight.tone}`} key={row.label}>
            <div className="briefing-row-label">{row.label}</div>
            <div className="briefing-row-value">{row.insight.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function sourceLabel(source) {
  if (source === "llm") return "AI";
  if (source === "fallback") return "Rule-based";
  return null;
}

function CoachMessageBubble({ message }) {
  const isUser = message.role === "user";
  const label = !isUser && !message.pending ? sourceLabel(message.source) : null;
  return (
    <div className={`coach-message-row ${isUser ? "coach-message-row-user" : "coach-message-row-coach"}`}>
      {!isUser && <div className="coach-avatar">AI</div>}
      <div className="coach-message-col">
        <div className={`coach-message-bubble ${isUser ? "coach-message-bubble-user" : "coach-message-bubble-coach"}`}>
          {message.pending ? (
            <span className="coach-thinking">
              <span className="coach-thinking-dot" />
              <span className="coach-thinking-dot" />
              <span className="coach-thinking-dot" />
            </span>
          ) : (
            message.text.split("\n").map((line, i) => <div key={i}>{line || "\u00A0"}</div>)
          )}
        </div>
        {label && <div className="coach-message-source">{label}</div>}
      </div>
    </div>
  );
}

function HandicapperAITab({ card, bankroll, preferences, pendingQuestion, onPendingQuestionHandled }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [insightsExpandedOnce, setInsightsExpandedOnce] = useState(false);
  const scrollRef = useRef(null);

  const context = useMemo(() => buildCoachContext(card, bankroll, preferences), [card, bankroll, preferences]);
  const insights = useMemo(() => generateAllInsights(context), [context]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const sendQuestion = useCallback(async (question) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setInsightsExpandedOnce(true);
    const userMsg = { id: cryptoId(), role: "user", text: trimmed };
    const pendingMsg = { id: cryptoId(), role: "coach", text: "", pending: true };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setInput("");

    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    const response = await activeCoachProvider.answerQuestion(context, trimmed, history);

    setMessages((prev) =>
      prev.map((m) => (m.id === pendingMsg.id ? { ...m, text: response.text, pending: false, source: response.source } : m))
    );
  }, [context, messages]);

  // Ask AI buttons elsewhere in the app (race cards, horse rows) hand off a
  // question via this prop rather than calling sendQuestion directly, since
  // those buttons live outside this component and the tab may not even be
  // mounted yet when they're tapped.
  useEffect(() => {
    if (pendingQuestion) {
      sendQuestion(pendingQuestion);
      onPendingQuestionHandled();
    }
  }, [pendingQuestion, sendQuestion, onPendingQuestionHandled]);

  const handleSubmit = (e) => {
    e.preventDefault();
    sendQuestion(input);
  };

  return (
    <div className="coach-tab">
      <TodaysBriefing context={context} />

      {!insightsExpandedOnce && messages.length === 0 && (
        <div className="coach-intro">
          <div className="coach-intro-title">Ask The Horse Handicapper AI</div>
          <p className="muted-text">
            The Horse Handicapper AI reads today's scores, confidence ratings, odds movement, pace projections,
            and bankroll — the exact same numbers shown on the Races and Bankroll tabs — and answers questions
            about them in plain language. When a real AI provider is configured it writes the answer; otherwise
            it falls back to the same rule-based engine automatically, so it always works.
          </p>
        </div>
      )}

      <div className="coach-insights-section">
        <div className="coach-insights-label">All insights</div>
        <div className="coach-insights-grid">
          {insights.map((insight) => (
            <CoachInsightCard key={insight.id} insight={insight} onAskAbout={(title) => sendQuestion(`Tell me more about: ${title}`)} />
          ))}
        </div>
      </div>

      <div className="coach-chat-section">
        <div className="coach-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="coach-empty-chat muted-text">Ask a question below, or tap an insight above to start.</div>
          ) : (
            messages.map((m) => <CoachMessageBubble key={m.id} message={m} />)
          )}
        </div>


        <div className="coach-suggested-prompts">
          {SUGGESTED_PROMPTS.map((p) => (
            <button key={p} className="coach-prompt-chip" onClick={() => sendQuestion(p)}>{p}</button>
          ))}
        </div>

        <form className="coach-input-row" onSubmit={handleSubmit}>
          <input
            className="coach-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about a race, a horse, value, pace, bankroll..."
          />
          <button className="btn coach-send-btn" type="submit">Send</button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BANKROLL MANAGER
// ---------------------------------------------------------------------------
function BankrollManager({ bankroll, onChange, card, summaries, trackingHistory }) {
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
          When a bet shows a price edge, suggested win stakes use a {(KELLY_FRACTION_CAP * 100).toFixed(1)}%
          fraction of full Kelly (capped at {(KELLY_MAX_PCT_OF_BANKROLL * 100).toFixed(0)}% of bankroll
          regardless of the math), not full Kelly. Full Kelly is mathematically optimal for long-run growth
          but far too volatile for everyday betting. These numbers are informational rather than a confident
          stake recommendation until this app has tracked enough real race results (see Track record below)
          to calibrate against. When there's no price edge at current odds, the app falls back to your flat
          unit size instead.
        </p>
      </div>

      <BankrollTrackRecord trackingHistory={trackingHistory} />

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

function BankrollTrackRecord({ trackingHistory }) {
  const stats = useMemo(() => computeTrackingStats(trackingHistory), [trackingHistory]);
  const roi = useMemo(() => computeApproximateROI(trackingHistory), [trackingHistory]);

  return (
    <div className="card">
      <div className="card-title">Track record</div>
      {stats.totalTracked === 0 ? (
        <p className="muted-text">
          No race results tracked yet. Enter finish order on a race's detail page once it's official — over
          time this builds a real history the model can eventually be calibrated against, instead of staying
          a black box.
        </p>
      ) : (
        <>
          <div className="bankroll-stat-row">
            <span>Races tracked</span>
            <span className="bankroll-stat-value">{stats.totalTracked}</span>
          </div>
          <div className="bankroll-stat-row">
            <span>Top pick win %</span>
            <span className="bankroll-stat-value">{stats.topPickWinPct == null ? "—" : `${stats.topPickWinPct}%`}</span>
          </div>
          <div className="bankroll-stat-row">
            <span>Best value win %</span>
            <span className="bankroll-stat-value">{stats.bestValueWinPct == null ? "—" : `${stats.bestValueWinPct}%`}</span>
          </div>
          <div className="bankroll-stat-row">
            <span>Suggested bet win %</span>
            <span className="bankroll-stat-value">{stats.suggestedBetWinPct == null ? "—" : `${stats.suggestedBetWinPct}%`}</span>
          </div>
          <div className="bankroll-stat-row">
            <span>Approx. ROI on graded Win/Place bets</span>
            <span className="bankroll-stat-value">{roi.roiPct == null ? "—" : `${roi.roiPct > 0 ? "+" : ""}${roi.roiPct}%`}</span>
          </div>
          {Object.keys(stats.byDecisionLabel).length > 0 && (
            <div className="bankroll-by-decision">
              <div className="bankroll-by-decision-title">Top pick win % by this app's call</div>
              {Object.entries(stats.byDecisionLabel).map(([label, b]) => (
                <div className="bankroll-race-row" key={label}>
                  <span>{label}</span>
                  <span>{b.count} race{b.count === 1 ? "" : "s"}</span>
                  <span className="bankroll-stat-value">{b.winPct}%</span>
                </div>
              ))}
            </div>
          )}
          <p className="muted-text" style={{ marginTop: 10 }}>
            ROI here is approximate — it credits a hit at even money as a placeholder since exact final odds
            aren't captured per bet, which understates true ROI on longer-priced winners. Treat these numbers
            as directional until {KELLY_MIN_TRACKED_BETS_FOR_CONFIDENCE} or more races are tracked.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DATA TAB — manual entry shortcuts + CSV upload
// ---------------------------------------------------------------------------
function DataTab({ card, onAddHorseToRace, onCSVImport, onEquibaseImport, races }) {
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
      <ImportEquibasePDF card={card} onImport={onEquibaseImport} />

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
  const [cards, setCards] = useState(() => {
    if (initialLoad?.cards?.length) return initialLoad.cards;
    return [blankCard()];
  });
  const [activeCardId, setActiveCardId] = useState(() => {
    if (initialLoad?.activeCardId && initialLoad.cards?.some((c) => c.id === initialLoad.activeCardId)) {
      return initialLoad.activeCardId;
    }
    if (initialLoad?.cards?.length) return initialLoad.cards[0].id;
    return null; // resolved by the effect below once `cards` is set
  });
  const [bankroll, setBankroll] = useState(
    () => initialLoad?.bankroll || { startingBankroll: "200", unitSize: "4" }
  );
  const [preferences, setPreferences] = useState(() => loadPreferences());
  const [betTrackingHistory, setBetTrackingHistory] = useState(() => loadBetTrackingHistory());
  const [showMigrationNotice, setShowMigrationNotice] = useState(!!initialLoad?.migratedFromOlderVersion);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [openRaceId, setOpenRaceId] = useState(null);
  const [editingHorse, setEditingHorse] = useState(null); // { raceId, horse }
  const [pendingAIQuestion, setPendingAIQuestion] = useState(null);
  const [showPreferences, setShowPreferences] = useState(false);

  // Ask AI buttons elsewhere in the app call this to jump to the Racing AI
  // tab with a pre-filled, auto-sent question about a specific race or horse.
  const askAIAbout = useCallback((question) => {
    setPendingAIQuestion(question);
    setActiveTab("coach");
    setOpenRaceId(null);
  }, []);

  // Resolve activeCardId on first mount if it couldn't be determined synchronously
  // (e.g. truly first-ever launch with no saved state at all).
  useEffect(() => {
    if (!activeCardId && cards.length) {
      setActiveCardId(cards[0].id);
    }
  }, [activeCardId, cards]);

  useEffect(() => {
    saveState({ cards, activeCardId, bankroll });
  }, [cards, activeCardId, bankroll]);

  // Preferences persist independently of card state — a separate localStorage
  // key, since they're global to the person, not scoped to any one card.
  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  // Bet tracking history persists independently too — a person's track
  // record shouldn't disappear if they delete the card it came from.
  useEffect(() => {
    saveBetTrackingHistory(betTrackingHistory);
  }, [betTrackingHistory]);

  const activeCard = cards.find((c) => c.id === activeCardId) || cards[0];

  const updateActiveCard = useCallback((updater) => {
    setCards((prev) =>
      prev.map((c) => (c.id === activeCardId ? (typeof updater === "function" ? updater(c) : updater) : c))
    );
  }, [activeCardId]);

  // --- Card-level actions (Race Cards screen) -------------------------------
  const createCard = useCallback((track, date) => {
    const newCard = blankCard(track, date);
    setCards((prev) => [...prev, newCard]);
    setActiveCardId(newCard.id);
    setOpenRaceId(null);
    setActiveTab("dashboard");
    return newCard.id;
  }, []);

  const switchCard = useCallback((cardId) => {
    setActiveCardId(cardId);
    setOpenRaceId(null);
    setActiveTab("dashboard");
  }, []);

  const deleteCard = useCallback((cardId) => {
    setCards((prev) => {
      const remaining = prev.filter((c) => c.id !== cardId);
      if (remaining.length === 0) {
        const replacement = blankCard();
        setActiveCardId(replacement.id);
        return [replacement];
      }
      if (cardId === activeCardId) {
        setActiveCardId(remaining[0].id);
      }
      return remaining;
    });
    setOpenRaceId(null);
  }, [activeCardId]);

  const duplicateCardAction = useCallback((cardId, newDate) => {
    setCards((prev) => {
      const source = prev.find((c) => c.id === cardId);
      if (!source) return prev;
      const copy = duplicateCard(source, newDate);
      setActiveCardId(copy.id);
      return [...prev, copy];
    });
    setOpenRaceId(null);
    setActiveTab("dashboard");
  }, []);

  // --- Race/horse-level actions, now operating on the active card ----------
  const updateRace = useCallback((updatedRace) => {
    updateActiveCard((c) => ({
      ...c,
      races: c.races.map((r) => (r.id === updatedRace.id ? updatedRace : r)),
    }));
  }, [updateActiveCard]);

  const addRace = useCallback(() => {
    updateActiveCard((c) => {
      const nextNum = (c.races[c.races.length - 1]?.raceNumber || 0) + 1;
      return { ...c, races: [...c.races, blankRace(nextNum)] };
    });
  }, [updateActiveCard]);

  const addHorseToRace = useCallback((raceId) => {
    const newHorse = blankHorse();
    updateActiveCard((c) => {
      const race = c.races.find((r) => r.id === raceId);
      if (!race) return c;
      const updatedRace = { ...race, horses: [...race.horses, newHorse] };
      return { ...c, races: c.races.map((r) => (r.id === raceId ? updatedRace : r)) };
    });
    setEditingHorse({ raceId, horse: newHorse });
    setActiveTab("dashboard");
    setOpenRaceId(raceId);
  }, [updateActiveCard]);

  const updateHorse = useCallback((raceId, updatedHorse) => {
    updateActiveCard((c) => ({
      ...c,
      races: c.races.map((r) =>
        r.id === raceId
          ? { ...r, horses: r.horses.map((h) => (h.id === updatedHorse.id ? updatedHorse : h)) }
          : r
      ),
    }));
    setEditingHorse((prev) => (prev && prev.horse.id === updatedHorse.id ? { ...prev, horse: updatedHorse } : prev));
  }, [updateActiveCard]);

  const removeHorse = useCallback((raceId, horseId) => {
    updateActiveCard((c) => ({
      ...c,
      races: c.races.map((r) =>
        r.id === raceId ? { ...r, horses: r.horses.filter((h) => h.id !== horseId) } : r
      ),
    }));
    setEditingHorse(null);
  }, [updateActiveCard]);

  const handleCSVImport = useCallback((newRaces) => {
    updateActiveCard((c) => ({ ...c, races: newRaces }));
  }, [updateActiveCard]);

  const handleApiImport = useCallback((newRaces) => {
    updateActiveCard((c) => ({ ...c, races: newRaces }));
  }, [updateActiveCard]);

  const handleEquibaseImport = useCallback((newRaces, meta) => {
    updateActiveCard((c) => ({
      ...c,
      races: newRaces,
      track: meta?.track || c.track,
      date: meta?.date || c.date,
    }));
  }, [updateActiveCard]);

  const snapshotOddsForRace = useCallback((raceId) => {
    updateActiveCard((c) => ({
      ...c,
      races: c.races.map((r) => (r.id === raceId ? snapshotRaceOdds(r) : r)),
    }));
  }, [updateActiveCard]);

  const summaries = useMemo(() => {
    const map = {};
    activeCard.races.forEach((race) => {
      map[race.id] = buildRaceSummary(race, bankroll);
    });
    return map;
  }, [activeCard, bankroll]);

  // The new, stricter decision layer — computed alongside summaries but
  // kept in its own map so summaries (and every existing reader of it,
  // including coach.js) stay completely unchanged.
  const betDecisions = useMemo(() => {
    const map = {};
    activeCard.races.forEach((race) => {
      map[race.id] = decideBet(summaries[race.id], race);
    });
    return map;
  }, [activeCard, summaries]);

  const recordRaceFinish = useCallback(
    (race, finishOrder) => {
      setBetTrackingHistory((history) =>
        recordFinishOrder(history, activeCard, race, finishOrder, summaries[race.id], betDecisions[race.id])
      );
    },
    [activeCard, summaries, betDecisions]
  );

  const deleteTrackingRecord = useCallback((key) => {
    setBetTrackingHistory((history) => removeTrackingRecord(history, key));
  }, []);

  const openRace = activeCard.races.find((r) => r.id === openRaceId) || null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-top-row">
          <div className="app-header-title">
            <HorseHandicapperLogo size={30} />
            <span className="app-header-name">The Horse Handicapper</span>
          </div>
          <button className="app-header-settings-btn" onClick={() => setShowPreferences(true)} aria-label="Your profile and preferences">
            ⚙
          </button>
        </div>
        <button className="app-header-card-switch" onClick={() => setActiveTab("cards")}>
          <span className="app-header-sub">{activeCard.track} · {formatDateLong(activeCard.date)}</span>
          <span className="app-header-card-count">{cards.length > 1 ? `${cards.length} cards ▾` : "Switch ▾"}</span>
        </button>
      </header>

      {showMigrationNotice && (
        <div className="migration-notice">
          Upgraded from the previous version — your races and horses carried over into a single race card.
          You can now create additional cards for other tracks/dates from the Cards tab.
          <button className="icon-btn" onClick={() => setShowMigrationNotice(false)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <main className="app-main">
        {activeTab === "cards" && (
          <RaceCardsScreen
            cards={cards}
            activeCardId={activeCardId}
            onCreateCard={createCard}
            onSwitchCard={switchCard}
            onDeleteCard={deleteCard}
            onDuplicateCard={duplicateCardAction}
          />
        )}

        {activeTab === "dashboard" && !openRace && (
          <Dashboard card={activeCard} summaries={summaries} betDecisions={betDecisions} onOpenRace={setOpenRaceId} onAddRace={addRace} onAskAI={askAIAbout} />
        )}

        {activeTab === "dashboard" && openRace && (
          <div className="race-detail-wrap">
            <button className="back-btn" onClick={() => setOpenRaceId(null)}>← All races</button>
            <RaceDetail
              race={openRace}
              summary={summaries[openRace.id]}
              betDecision={betDecisions[openRace.id]}
              card={activeCard}
              trackingHistory={betTrackingHistory}
              onRecordFinish={recordRaceFinish}
              onDeleteTrackingRecord={deleteTrackingRecord}
              onUpdateRace={updateRace}
              onAddHorse={() => addHorseToRace(openRace.id)}
              onEditHorse={(horse) => setEditingHorse({ raceId: openRace.id, horse })}
              onSnapshotOdds={snapshotOddsForRace}
              bankroll={bankroll}
              onAskAI={askAIAbout}
            />
          </div>
        )}

        {activeTab === "data" && (
          <DataTab
            card={activeCard}
            races={activeCard.races}
            onAddHorseToRace={(raceId) => {
              addHorseToRace(raceId);
            }}
            onCSVImport={handleCSVImport}
            onApiImport={handleApiImport}
            onEquibaseImport={handleEquibaseImport}
          />
        )}

        {activeTab === "coach" && (
          <HandicapperAITab
            card={activeCard}
            bankroll={bankroll}
            preferences={preferences}
            pendingQuestion={pendingAIQuestion}
            onPendingQuestionHandled={() => setPendingAIQuestion(null)}
          />
        )}

        {activeTab === "bankroll" && (
          <BankrollManager bankroll={bankroll} onChange={setBankroll} card={activeCard} summaries={summaries} trackingHistory={betTrackingHistory} />
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

      {showPreferences && (
        <div className="modal-overlay" onClick={() => setShowPreferences(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <PreferencesScreen
              preferences={preferences}
              onChange={setPreferences}
              onClose={() => setShowPreferences(false)}
            />
          </div>
        </div>
      )}

      <nav className="tab-bar">
        <TabButton label="Cards" active={activeTab === "cards"} onClick={() => { setActiveTab("cards"); setOpenRaceId(null); }} />
        <TabButton label="Races" active={activeTab === "dashboard"} onClick={() => { setActiveTab("dashboard"); setOpenRaceId(null); }} />
        <TabButton label="AI" active={activeTab === "coach"} onClick={() => { setActiveTab("coach"); setOpenRaceId(null); }} />
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
