import { existsSync } from 'node:fs';
import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'audit-before-build';
const CONFIG_KEY = 'requireAuditBeforeBuilding';

const DEFAULT_EXECUTABLE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.sh',
  '.ps1',
];
const DEFAULT_TOOL_FOLDERS = ['scripts/', 'hooks/', 'tools/'];

const NEW_TOOL_INTENT_PATTERN =
  /\b(create|write|build|add)\b[^.]{0,60}\b(script|verifier|checker|gate|hook|linter|tool)\b/i;

const AUDIT_EVIDENCE_PATTERN =
  /already exists|no existing tool|no plugin|audited and|justification:|no existe una herramienta|no existe la herramienta|no hay plugin|ya existe|busque? si ya existe|verifiqu[eé] que no (hay|existe)|audit[eé] herramientas|justificacion:|justificaci[oó]n:/i;

const INLINE_JUSTIFICATION_PATTERN =
  /justification:|no-reinvent|audit:|justificacion:|justificaci[oó]n:/i;

function checkDelegation(toolInput) {
  const prompt = toolInput?.prompt;
  if (typeof prompt !== 'string') return;
  if (!NEW_TOOL_INTENT_PATTERN.test(prompt)) return;
  if (AUDIT_EVIDENCE_PATTERN.test(prompt)) return;

  deny(
    GATE_ID,
    'Delegating creation of a new script/checker/gate/hook/linter/tool without evidence of a prior audit. State what you searched and why no existing tool covers this (e.g. "audited and no existing tool...").',
  );
}

function isNewToolFile(filePath, parameters) {
  if (!filePath) return false;
  const inToolFolder = parameters.toolFolders.some((folder) =>
    filePath.includes(folder),
  );
  if (!inToolFolder) return false;
  return parameters.executableExtensions.some((extension) =>
    filePath.endsWith(extension),
  );
}

function checkWrite(toolInput, parameters) {
  const rawPath = toolInput?.file_path ?? '';
  const filePath = rawPath.replace(/\\/g, '/');
  if (!isNewToolFile(filePath, parameters)) return;

  // Editing an EXISTING file is not building a new tool — only creation needs the audit.
  // A file already on disk (any tool that carries file_path) is an edit, so it is allowed.
  // This is what makes maintaining the gates themselves possible with the gates active.
  if (rawPath && existsSync(rawPath)) return;

  const content = toolInput?.content ?? toolInput?.new_string;
  if (typeof content !== 'string') return;
  if (INLINE_JUSTIFICATION_PATTERN.test(content)) return;

  deny(
    GATE_ID,
    `Creating a new executable tool at ${filePath} without a justification comment (e.g. "justification: ..."). Document why no existing tool covers this before building a new one.`,
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      executableExtensions: DEFAULT_EXECUTABLE_EXTENSIONS,
      toolFolders: DEFAULT_TOOL_FOLDERS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (TOOL_GROUPS.delegation.includes(toolName)) {
      checkDelegation(toolInput);
      return;
    }
    if (!TOOL_GROUPS.write.includes(toolName)) return;
    checkWrite(toolInput, parameters);
  },
);
