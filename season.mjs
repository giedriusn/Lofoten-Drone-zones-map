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
//
// The prose form terminates each date with a period ("15.4. - 31.7."); the parenthetical
// summary uses the bare form ("15.4-31.7"). Both must parse — a trailing "." is optional.
// An out-of-range day/month ("13.40-99.99") is rejected so garbage can't become a window,
// and identical ranges (the summary echoed in the prose) are deduped.
//
// The parser deliberately does NOT try to reject measurement-shaped ranges ("2.5-3.5 km"):
// you can't tell a date from a measurement by a trailing unit without risking dropping a
// REAL date (the unsafe direction), and it isn't worth it — the `restriction` layer is
// ALWAYS a no-fly in the verdict, so a window only drives the popup's "in force today"
// text. Erring toward parsing keeps a real ban from ever silently reading "not in force".
// (No such measurement range exists in the Naturbase source anyway.)
// LIMITATION: day.month only — a fully-dated "15.4.2025-31.7.2025" range is not parsed
// (the year defeats the dash); not present in the source today.
export function parseRestrictionWindows(text) {
  const pad = (n) => String(n).padStart(2, "0");
  const out = [];
  const seen = new Set();
  const re = /(\d{1,2})\.(\d{1,2})\.?\s*-\s*(\d{1,2})\.(\d{1,2})\.?/g;
  const valid = (d, mo) => d >= 1 && d <= 31 && mo >= 1 && mo <= 12;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const d1 = +m[1], mo1 = +m[2], d2 = +m[3], mo2 = +m[4];
    if (!valid(d1, mo1) || !valid(d2, mo2)) continue;
    const from = `${pad(mo1)}-${pad(d1)}`, to = `${pad(mo2)}-${pad(d2)}`;
    const key = `${from}/${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
  }
  return out;
}

// A restriction zone is "in force today" if it is year-round or any of its windows is
// active now. Bridges the windows[] array shape to the scalar nestingActive helper.
export function windowsActive(windows, yearRound, today = new Date()) {
  if (yearRound) return true;
  return Array.isArray(windows) && windows.some((w) => nestingActive(w.from, w.to, today));
}
