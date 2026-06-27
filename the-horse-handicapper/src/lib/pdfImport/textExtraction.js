// ============================================================================
// PDF TEXT EXTRACTION ENGINE — pdfjs-dist glyph-level extraction with
// gap-based word-joining and y-tolerance row clustering.
//
// WHY THIS EXISTS: pdfjs-dist's default text items do not reliably preserve
// word spacing for this PDF family (confirmed against real Equibase exports
// during prototyping) — words run together ("ProgramHelp", "JustBernie").
// This module reconstructs proper row text directly from glyph x/y/width
// data, the same approach validated against pdfplumber ground truth before
// porting here. No OCR, no rasterization — this reads the PDF's real text
// layer via pdfjs-dist's getTextContent().
//
// Two calibrated constants, both derived from inspecting real glyph
// positions in Equibase Premium PP exports:
//   - Y_TOLERANCE: vertical pixel tolerance for "same row" clustering.
//     Equibase's running-line rows are NOT perfectly single-baseline; a few
//     points (race-type marker, trip comment) land a hair off the main
//     baseline. Clustering with tolerance reassembles them correctly.
//   - GAP_THRESHOLD: horizontal pixel gap that signals a word boundary vs.
//     a same-word character gap. Intra-word gaps measured ~0pt; real word
//     boundaries measured ~1.9-2.2pt at this PDF's font size/scale.
// These are exposed as constants (not magic numbers buried in functions)
// so a future re-calibration against a different Equibase export format
// is a one-line change, not an archaeology project.
// ============================================================================

export const Y_TOLERANCE = 1.6;
export const GAP_THRESHOLD = 1.5;
export const MIN_ROW_LENGTH = 3; // drops stray single-glyph noise (trouble/turf icons)

// Equibase's running lines use proprietary glyph codes for footnote/fraction
// marks (fractional internal times, trouble indicators). These render as
// literal "(cid:N)" sequences when a font's glyph has no Unicode mapping.
// Per investigation, none of these carry information needed by any schema
// field — they're stripped rather than mapped.
const CID_GLYPH_PATTERN = /\(cid:\d+\)/g;

/**
 * Extracts every page of a PDF as an array of reconstructed text rows,
 * plus the raw glyph list per page for the few fields (program number)
 * where row-level clustering proved too fragile against this PDF's font
 * baseline jitter and a direct coordinate lookup is more reliable.
 * @param {ArrayBuffer} arrayBuffer - the raw PDF file bytes
 * @param {object} pdfjsLib - the pdfjs-dist module (injected so this stays
 *   testable/swappable without a hard import at module scope)
 * @returns {Promise<{pageIndex: number, rows: string[], glyphs: object[]}[]>}
 */
export async function extractPdfRows(arrayBuffer, pdfjsLib) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const glyphs = textContent.items
      .filter((item) => typeof item.str === "string" && item.str.length > 0)
      .map((item) => glyphFromTextItem(item));
    const rows = clusterAndJoin(glyphs);
    pages.push({ pageIndex: pageNum - 1, rows, glyphs });
  }
  return pages;
}

// pdfjs-dist TextItem.transform is [scaleX, skewX, skewY, scaleY, x, y].
// y in pdfjs-dist increases upward (PDF coordinate space); we don't need to
// flip it since we only ever compare y-values to each other for clustering,
// never to a fixed page-relative "top" notion.
function glyphFromTextItem(item) {
  const x = item.transform[4];
  const y = item.transform[5];
  const width = item.width || 0;
  return { text: item.str, x0: x, x1: x + width, y };
}

// Groups glyphs into rows by y-proximity (not exact match — Equibase rows
// are not perfectly single-baseline), then joins each row left-to-right,
// inserting a space wherever the horizontal gap between glyphs exceeds
// GAP_THRESHOLD. Strips proprietary glyph-code artifacts.
function clusterAndJoin(glyphs) {
  if (!glyphs.length) return [];
  const sorted = [...glyphs].sort((a, b) => {
    if (Math.abs(a.y - b.y) > GAP_THRESHOLD) return b.y - a.y; // top-to-bottom (pdfjs y is inverted)
    return a.x0 - b.x0;
  });

  const clusters = [];
  let current = [];
  let anchorY = null;
  for (const g of sorted) {
    if (anchorY === null || Math.abs(g.y - anchorY) <= Y_TOLERANCE) {
      current.push(g);
      if (anchorY === null) anchorY = g.y;
    } else {
      clusters.push(current);
      current = [g];
      anchorY = g.y;
    }
  }
  if (current.length) clusters.push(current);

  return clusters
    .map((cluster) => joinClusterText(cluster))
    .filter((row) => row.length >= MIN_ROW_LENGTH);
}

function joinClusterText(cluster) {
  const sorted = [...cluster].sort((a, b) => a.x0 - b.x0);
  let text = "";
  let prevX1 = null;
  for (const g of sorted) {
    if (prevX1 !== null && g.x0 - prevX1 > GAP_THRESHOLD) {
      text += " ";
    }
    text += g.text;
    prevX1 = g.x1;
  }
  return text.replace(CID_GLYPH_PATTERN, "").trim();
}

/**
 * Flattens the per-page row arrays into one continuous array of
 * { pageIndex, row } records, preserving page provenance for section
 * detection and debugging.
 */
export function flattenPages(pages) {
  const flat = [];
  for (const { pageIndex, rows } of pages) {
    for (const row of rows) {
      flat.push({ pageIndex, row });
    }
  }
  return flat;
}
