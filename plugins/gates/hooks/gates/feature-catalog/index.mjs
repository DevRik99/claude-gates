// feature-catalog — enforces the machine-readable feature catalog's own invariants on
// a write to that file: at most one feature `in_progress` at a time, and `done` is
// never written directly (only a review/QA process closes a feature). Migrated from
// ~/.claude/hooks/guard-feature-catalog.mjs.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   catalogFileName   basename of the catalog file this gate watches for (default
//                      feature_list.json). A write to any other file is ignored.
//   maxInProgress     how many features may be `in_progress` simultaneously.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── Auto-off when the project never adopted the catalog ────────────────────────────
// This gate only inspects the CONTENT being written to a file named `catalogFileName`.
// A project that never uses that file never triggers it — there is nothing to disable
// separately, the check is inert by construction rather than by a discovery pass.
//
// ── What is NOT configurable (base, non-negotiable) ─────────────────────────────────
// Writing `status: done` directly is always denied, regardless of `maxInProgress`: only
// a review/QA subagent or a validated automated process may close a feature, and this
// gate has no way to tell who is writing, so it blocks the write itself.

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'feature-catalog';
const CONFIG_KEY = 'requireFeatureCatalog';

const WRITE_TOOLS = new Set(TOOL_GROUPS.write);

const DEFAULT_CATALOG_FILE_NAME = 'feature_list.json';
const DEFAULT_MAX_IN_PROGRESS = 1;

const DONE_STATUS_PATTERN = /"status"\s*:\s*"done"|status\s*:\s*['"]done['"]/i;
const IN_PROGRESS_STATUS_PATTERN = /"status"\s*:\s*"in_progress"/g;

/** The path a write tool targets, across the field names different tools use. */
function writeTargetFrom(toolInput) {
  return String(
    toolInput.TargetFile ??
      toolInput.target_file ??
      toolInput.file_path ??
      toolInput.path ??
      '',
  );
}

/** The content a write tool is about to write, across the field names tools use. */
function writeContentFrom(toolInput) {
  return String(
    toolInput.CodeContent ??
      toolInput.ReplacementContent ??
      toolInput.content ??
      '',
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      catalogFileName: DEFAULT_CATALOG_FILE_NAME,
      maxInProgress: DEFAULT_MAX_IN_PROGRESS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!WRITE_TOOLS.has(toolName)) return;

    const target = writeTargetFrom(toolInput);
    const catalogFileName = String(
      parameters.catalogFileName ?? DEFAULT_CATALOG_FILE_NAME,
    );
    if (!target.includes(catalogFileName)) return;

    const content = writeContentFrom(toolInput);

    // Base, non-negotiable: `done` is never written directly to the catalog.
    if (DONE_STATUS_PATTERN.test(content)) {
      deny(
        GATE_ID,
        `Writing 'status: done' directly to ${catalogFileName} is not allowed. ` +
          'Only a review/QA subagent or a validated automated process may close a feature.',
      );
    }

    const maxInProgress = Number(
      parameters.maxInProgress ?? DEFAULT_MAX_IN_PROGRESS,
    );
    const inProgressCount = (content.match(IN_PROGRESS_STATUS_PATTERN) ?? [])
      .length;
    if (inProgressCount > maxInProgress) {
      deny(
        GATE_ID,
        `${catalogFileName} would have ${inProgressCount} features 'in_progress'; ` +
          `the maximum allowed is ${maxInProgress}.`,
      );
    }
  },
);
