import { gateParameters, isGateEnabled } from '../../lib/config.mjs';
import { coerceParameters, readHookPayload } from '../../lib/hook-io.mjs';
import { CONFIG_KEY, DEFAULT_PARAMS } from './shared.mjs';

const PROBE_TIMEOUT_MS = 1500;
const SESSION_START_EVENT = 'SessionStart';
const NOT_ENROLLED = 'non_enrolled_pending_mutations';

async function getJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return response.json();
}

function withoutTrailingSlash(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end -= 1;
  return text.slice(0, end);
}

function speak(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: SESSION_START_EVENT,
        additionalContext: context,
      },
    }),
  );
}

function enrollmentProblem(status, projectName) {
  if (!status || status.reason_code !== NOT_ENROLLED) return null;
  const message = String(status.reason_message ?? '');
  if (projectName && !message.includes(`${projectName}=`)) return null;
  return projectName ?? 'this project';
}

async function main() {
  const cwd = process.cwd();
  if (!isGateEnabled(CONFIG_KEY, true, cwd)) return;
  const { parameters } = coerceParameters(
    DEFAULT_PARAMS,
    gateParameters(CONFIG_KEY, cwd),
  );
  const base = withoutTrailingSlash(String(parameters.engramUrl));
  const status = await getJson(`${base}/sync/status`);
  if (!status) return;
  const current = await getJson(
    `${base}/project/current?cwd=${encodeURIComponent(cwd)}`,
  );
  const project = enrollmentProblem(status, current?.project);
  if (!project) return;
  speak(
    `[${CONFIG_KEY}] Engram cloud is configured but "${project}" is not enrolled, so its memories stay ` +
      `local only (daemon reports ${status.reason_code}). Run \`engram cloud enroll ${project}\` once ` +
      'to replicate them; local SQLite remains the source of truth either way.',
  );
}

readHookPayload();
main().catch(() => {});
