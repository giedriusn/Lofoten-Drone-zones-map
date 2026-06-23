// season.mjs
// Is a seasonal window active on a given day? Windows are "MM-DD" strings, so the
// result is year-independent — the data file bakes the window, the browser decides
// "now". Bounds inclusive. Handles a window that wraps the new year (from > to),
// though the seabird nesting window (Apr→Jul) does not.
export function nestingActive(from, to, today = new Date()) {
  const md = (s) => {
    const m = /^(\d{2})-(\d{2})$/.exec(s || "");
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  };
  const f = md(from), t = md(to);
  if (f == null || t == null) return false; // never claim a ban we can't bound
  const now = (today.getMonth() + 1) * 100 + today.getDate();
  return f <= t ? now >= f && now <= t : now >= f || now <= t;
}

// Parse Norwegian restriction date ranges ("15.4-31.7", "1.1-31.12") out of the
// official restriksjonerBeskrivelse text into {from,to} "MM-DD" windows. The text is
// day.month-day.month; a zone may list several ranges (one per restriction). "1.1-31.12"
// is a year-round ban. "< 300 m" and other non-range numbers are ignored (no D.M-D.M).
export function parseRestrictionWindows(text) {
  const pad = (n) => String(n).padStart(2, "0");
  const out = [];
  const re = /(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const [, d1, mo1, d2, mo2] = m;
    out.push({ from: `${pad(mo1)}-${pad(d1)}`, to: `${pad(mo2)}-${pad(d2)}` });
  }
  return out;
}

// A restriction zone is "in force today" if it is year-round or any of its windows is
// active now. Bridges the windows[] array shape to the scalar nestingActive helper.
export function windowsActive(windows, yearRound, today = new Date()) {
  if (yearRound) return true;
  return Array.isArray(windows) && windows.some((w) => nestingActive(w.from, w.to, today));
}
