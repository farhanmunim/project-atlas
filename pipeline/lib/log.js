/**
 * log.js — tiny structured logger + step timing for the pipeline.
 *
 * Pipelines run unattended (CI/cron), so logs are the only window into a run.
 * Lines are prefixed and machine-greppable; `step()` returns a stopper that
 * prints the elapsed time, so every stage reports its own duration.
 */

const ICONS = { info: "·", ok: "✓", warn: "⚠", err: "✗", run: "▶" };

function stamp() {
  // wall-clock is fine here — pipeline logs are not replayed/cached
  return new Date().toISOString().slice(11, 19);
}

function line(level, msg) {
  const fn = level === "err" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`${stamp()} ${ICONS[level] || "·"} ${msg}`);
}

export const log = {
  info: (m) => line("info", m),
  ok:   (m) => line("ok", m),
  warn: (m) => line("warn", m),
  err:  (m) => line("err", m),
  /** Begin a named step; returns done(extra?) → logs "✓ <name> (1.2s) <extra>". */
  step(name) {
    line("run", name);
    const t0 = Date.now();
    return (extra = "") => line("ok", `${name} — ${((Date.now() - t0) / 1000).toFixed(1)}s${extra ? " · " + extra : ""}`);
  },
};
