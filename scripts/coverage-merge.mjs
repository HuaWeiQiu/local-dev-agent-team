#!/usr/bin/env node
/**
 * Merge several coverage reports line by line, by majority.
 *
 * Why not "the reports must be identical": a single missed line should not invalidate a
 * whole report. Why not "vote for the whole report": one run can miss a block in file A
 * while another has an extra hit in file B, so report-level voting would freeze whichever
 * noise happens to be in the majority — including the *higher* CRAP.
 *
 * The rule here is per line: a line is covered when at least half of the runs executed it
 * (2 of 3, 3 of 5). A path executed in the majority of identical runs is stable code; one
 * execution is sampling noise; zero is a line nobody tested.
 *
 * Pure functions only: parsing, merging, serializing. No filesystem, no child processes.
 */

/** `DA:<line>,<hits>[,<checksum>]` — the only field this module needs per line. */
const DA_PATTERN = /^DA:(\d+),(\d+)/;
const SF_PATTERN = /^SF:(.*)$/;
const LF_PATTERN = /^LF:(\d+)$/;
const LH_PATTERN = /^LH:(\d+)$/;

/**
 * Parse lcov text into `file -> { lines: Map<number, hits>, summary: {lf, lh} }`.
 * Fields this module does not need are preserved verbatim so the merged report stays
 * readable by the tools that consume lcov.
 */
export function parseLcov(text) {
  const files = new Map();
  let current;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const sf = SF_PATTERN.exec(line);
    if (sf) {
      current = { path: sf[1], lines: new Map(), extras: [], lf: undefined, lh: undefined };
      files.set(current.path, current);
      continue;
    }
    if (!current) continue;
    const da = DA_PATTERN.exec(line);
    if (da) {
      // Repeated DA for one line: keep the maximum, which is what "was it executed" means.
      const number = Number(da[1]);
      const hits = Number(da[2]);
      current.lines.set(number, Math.max(current.lines.get(number) ?? 0, hits));
      continue;
    }
    const lf = LF_PATTERN.exec(line);
    if (lf) {
      current.lf = Number(lf[1]);
      continue;
    }
    const lh = LH_PATTERN.exec(line);
    if (lh) {
      current.lh = Number(lh[1]);
      continue;
    }
    if (line === "end_of_record") continue;
    if (line !== "") current.extras.push(line);
  }
  return files;
}

/**
 * Merge parsed reports. `quorum` defaults to "more than half".
 *
 * Returns the merged lines, how many lines disagreed between runs (`divergentLines`), and
 * the files that appeared in only some reports — a file missing from one run is reported
 * rather than silently dropped, because that is the shape of a lost worker.
 */
export function mergeReports(reports, { quorum } = {}) {
  const threshold = quorum ?? Math.floor(reports.length / 2) + 1;
  const paths = new Set(reports.flatMap((report) => [...report.keys()]));
  const merged = new Map();
  let divergentLines = 0;
  const partialFiles = [];

  for (const path of [...paths].sort()) {
    const present = reports.filter((report) => report.has(path));
    if (present.length < reports.length) partialFiles.push({ path, presentIn: present.length });
    const lineNumbers = new Set(present.flatMap((report) => [...report.get(path).lines.keys()]));
    const lines = new Map();
    for (const number of [...lineNumbers].sort((left, right) => left - right)) {
      const executions = present.filter((report) => (report.get(path).lines.get(number) ?? 0) > 0).length;
      if (executions > 0 && executions < reports.length) divergentLines += 1;
      lines.set(number, executions >= threshold ? 1 : 0);
    }
    const extras = present[0]?.get(path).extras ?? [];
    merged.set(path, { path, lines, extras });
  }

  return { merged, divergentLines, partialFiles, threshold };
}

/** The merged coverage as lcov text, with LF/LH recomputed from the merged lines. */
export function serializeLcov(merged) {
  const blocks = [];
  for (const { path, lines, extras } of merged.values()) {
    const entries = [...lines.entries()].sort((left, right) => left[0] - right[0]);
    const covered = entries.filter(([, hits]) => hits > 0).length;
    blocks.push(
      [
        `SF:${path}`,
        ...extras,
        ...entries.map(([number, hits]) => `DA:${number},${hits}`),
        `LF:${entries.length}`,
        `LH:${covered}`,
        "end_of_record",
      ].join("\n"),
    );
  }
  return `${blocks.join("\n")}\n`;
}

/** Parse, merge and serialize in one step; also reports what disagreed. */
export function mergeCoverageReports(texts, options = {}) {
  const { merged, divergentLines, partialFiles, threshold } = mergeReports(
    texts.map((text) => parseLcov(text)),
    options,
  );
  return { lcov: serializeLcov(merged), divergentLines, partialFiles, threshold };
}
