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
