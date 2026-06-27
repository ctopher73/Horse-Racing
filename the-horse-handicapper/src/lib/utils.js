// ============================================================================
// SHARED UTILITIES — tiny, generic helpers used across multiple modules.
// ============================================================================

export function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function clamp(v, lo, hi) {
  if (typeof v !== "number" || isNaN(v)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function formatDateLong(iso) {
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

export function formatTimeShort(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}
