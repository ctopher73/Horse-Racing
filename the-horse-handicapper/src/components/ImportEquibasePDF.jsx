// ============================================================================
// EQUIBASE PDF IMPORT — UI component for the Data tab.
//
// Workflow: Choose PDF -> Parse (client-side, pdfjs-dist) -> Preview
// (race/horse counts + Data Quality Report) -> Import (writes into the
// active card via onImport, exactly like CSV import does via onCSVImport).
//
// Parsing is 100% client-side. No Netlify Function, no upload of the PDF
// anywhere — pdfjs-dist reads the file directly in the browser.
// ============================================================================
import React, { useState, useRef } from "react";
import { importEquibasePdf } from "../lib/pdfImport/equibaseParser.js";

// pdfjs-dist is loaded lazily (dynamic import) so the rest of the app's
// initial bundle isn't weighed down by it until someone actually opens
// this import flow.
async function loadPdfJs() {
  const pdfjsLib = await import("pdfjs-dist");
  // The worker must be configured for pdfjs-dist to parse in the browser
  // without blocking the main thread. Using the bundler-served worker URL
  // keeps this working under Vite's dev server and production build alike.
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjsLib;
}

export default function ImportEquibasePDF({ card, onImport }) {
  const fileInputRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | parsing | preview | error
  const [parseResult, setParseResult] = useState(null); // { card, qualityReport, errors }
  const [statusMsg, setStatusMsg] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setStatus("parsing");
    setStatusMsg(null);
    setParseResult(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = await loadPdfJs();
      const result = await importEquibasePdf(arrayBuffer, pdfjsLib);

      if (!result.card) {
        setStatus("error");
        setStatusMsg({ tone: "error", text: result.errors.join(" ") || "Could not parse this PDF." });
        return;
      }

      setParseResult(result);
      setStatus("preview");
    } catch (err) {
      console.error("Equibase PDF import failed:", err);
      setStatus("error");
      setStatusMsg({
        tone: "error",
        text: "Something went wrong reading that PDF. Make sure it's an Equibase Premium Past Performances export.",
      });
    }
  };

  const confirmImport = () => {
    if (!parseResult?.card?.races?.length) return;
    onImport(parseResult.card.races, {
      track: parseResult.card.track,
      date: parseResult.card.date,
    });
    setStatus("idle");
    setStatusMsg({
      tone: "success",
      text: `Imported ${parseResult.qualityReport.racesImported} race(s) and ${parseResult.qualityReport.horsesImported} horse(s).`,
    });
    setParseResult(null);
  };

  const cancelPreview = () => {
    setStatus("idle");
    setParseResult(null);
  };

  return (
    <div className="card">
      <div className="card-title">Import Equibase PDF</div>
      <p className="muted-text">
        Upload an Equibase Premium Past Performances PDF and the race card — track, date, races, and
        horses — will be extracted automatically. Class ratings, speed figures, and trainer/jockey stats
        come along too. Nothing is sent anywhere; the PDF is read entirely in your browser.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={handleFile}
        style={{ display: "none" }}
      />
      <button
        className="btn btn-block"
        onClick={() => fileInputRef.current?.click()}
        disabled={status === "parsing"}
      >
        {status === "parsing" ? "Parsing PDF…" : "Choose Equibase PDF"}
      </button>

      {statusMsg && <div className={`import-msg import-msg-${statusMsg.tone}`}>{statusMsg.text}</div>}

      {status === "preview" && parseResult && (
        <EquibaseImportPreview
          card={card}
          parseResult={parseResult}
          onConfirm={confirmImport}
          onCancel={cancelPreview}
        />
      )}
    </div>
  );
}

function EquibaseImportPreview({ card, parseResult, onConfirm, onCancel }) {
  const { card: parsedCard, qualityReport } = parseResult;
  const trackMismatch = card.track && parsedCard.track && card.track !== parsedCard.track;

  return (
    <div className="pdf-import-preview">
      <div className="pdf-import-preview-header">
        <strong>{parsedCard.track || "Unknown track"}</strong>
        {parsedCard.date && <span> &middot; {parsedCard.date}</span>}
      </div>

      {trackMismatch && (
        <div className="import-msg import-msg-error">
          This PDF is for {parsedCard.track}, but your active card is for {card.track}. Importing will
          replace this card's races with {parsedCard.track}'s races.
        </div>
      )}

      <div className="pdf-import-quality-report">
        <div className="pdf-import-quality-row">
          <span>Races imported</span>
          <strong>{qualityReport.racesImported}</strong>
        </div>
        <div className="pdf-import-quality-row">
          <span>Horses imported</span>
          <strong>{qualityReport.horsesImported}</strong>
        </div>
        <div className="pdf-import-quality-row">
          <span>Overall field coverage</span>
          <strong>{qualityReport.overallConfidencePct}%</strong>
        </div>
      </div>

      <details className="pdf-import-field-detail">
        <summary>Field-by-field coverage</summary>
        <div className="weights-list">
          {qualityReport.fieldCoverage.map((f) => (
            <div className="weight-row" key={f.field}>
              <span className="weight-row-label">{fieldLabel(f.field)}</span>
              <div className="weight-row-bar-track">
                <div className="weight-row-bar-fill" style={{ width: `${f.pct}%` }} />
              </div>
              <span className="weight-row-pct">
                {f.filled}/{f.total}
              </span>
            </div>
          ))}
        </div>
      </details>

      {qualityReport.errors.length > 0 && (
        <details className="pdf-import-field-detail">
          <summary>{qualityReport.errors.length} note(s) about this import</summary>
          <ul className="pdf-import-errors-list">
            {qualityReport.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="pdf-import-preview-races">
        {parsedCard.races.map((race) => (
          <div className="pdf-import-race-row" key={race.raceNumber}>
            <span className="pdf-import-race-num">R{race.raceNumber}</span>
            <span className="pdf-import-race-meta">
              {race.distance || "—"} &middot; {race.surface} &middot; {race.raceType || "—"}
            </span>
            <span className="pdf-import-race-horses">{race.horses.length} horses</span>
          </div>
        ))}
      </div>

      <button className="btn btn-block" onClick={onConfirm}>
        Import {qualityReport.racesImported} race(s) into this card
      </button>
      <button className="btn btn-ghost btn-block" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function fieldLabel(field) {
  const labels = {
    programNumber: "Program number",
    name: "Horse name",
    jockey: "Jockey",
    trainer: "Trainer",
    mlOdds: "Morning line odds",
    classRating: "Class rating",
    speedFigs: "Speed figure",
    last3Finishes: "Recent finishes",
    trainerWinPct: "Trainer win %",
    jockeyWinPct: "Jockey win %",
    daysSinceLastRace: "Days since last race",
    workouts: "Workouts",
  };
  return labels[field] || field;
}
