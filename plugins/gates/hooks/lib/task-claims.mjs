// task-claims — reading the task store's CLAIM shape (owner + claimedAt) from inside a gate,
// and answering the one question several gates need: does this task block the agent that is
// acting right now?
//
// justification: no existing helper covers this. The tasks plugin owns the claim logic, but
// a gate cannot import it — the gates plugin installs on its own, and a cross-plugin import
// would break every gate wherever only this one is present. So the shape is re-read here.
// This is the same promotion `lib/shell-safety.mjs` documents: require-task-split grew a
// private copy first, stop-pending needed the identical rule, and a second copy is where the
// two silently drift apart.
//
// The rule, and why it is this way rather than the obvious alternative:
//
//   A FREE task blocks whoever is acting. Free means "nobody has taken it yet", NOT "belongs
//   to no one and therefore blocks no one". Exempting free tasks would quietly switch these
//   gates off for every project written before claims existed, and for any environment that
//   does not expose a session id — a silent disable is worse than an occasional false block.
//
//   Only ANOTHER agent's LIVE claim exempts you. That is the case that was actually broken:
//   one agent's unsplit task denied execution to every other agent in the project, blocking
//   the harmless case (untidy bookkeeping elsewhere) while never guarding the dangerous one
//   (two agents editing the same file).
//
//   A claim EXPIRES. An agent that dies without releasing would otherwise hold the backlog
//   hostage forever; past the TTL the task is free again with nobody having to intervene.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonOrNull } from './config.mjs';

const DEFAULT_IDLE_MINUTES = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;

export const DEFAULT_IDLE_MS = DEFAULT_IDLE_MINUTES * MS_PER_MINUTE;

/**
 * Cuánto silencio convierte una reserva en libre. Vive en la RAÍZ de `.ai/config.json` y no
 * como param de cada gate porque los tres que leen reservas tienen que coincidir: repetirlo
 * por gate deja al usuario con tres sitios donde desincronizarlo.
 *
 *   { "claimIdleMinutes": 60, "gates": { ... } }
 */
export function idleWindowMs(root) {
  const declared = root
    ? readJsonOrNull(join(root, '.ai', 'config.json'))?.claimIdleMinutes
    : undefined;
  const minutes = Number(declared);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * MS_PER_MINUTE
    : DEFAULT_IDLE_MS;
}

// Porque un TTL fijo es un mal sustituto de la pregunta real, se consulta si la sesión dueña
// SIGUE ahí: con 8 horas, una sesión muerta hace un minuto retiene su trabajo el resto del
// día, y una que lleva 9 horas trabajando lo pierde.
//
// Claude Code escribe el transcript de cada sesión en
// ~/.claude/projects/<raiz-con-separadores-como-guiones>/<session-id>.jsonl y lo toca en cada
// turno, de modo que su mtime es una señal de vida real, barata y sin protocolo nuevo.
//
// Tres estados en vez de dos: un transcript ausente NO se lee como sesión muerta, porque la
// derivación de la ruta podría fallar en otra plataforma y robar una reserva por eso sería
// peor que esperar. Ese caso cae al TTL de siempre.
function transcriptPathFor(owner, root) {
  const slug = String(root).replace(/[:\\/]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, `${owner}.jsonl`);
}

export function ownerSessionState(owner, root, now = Date.now()) {
  if (!owner || !root) return 'unknown';
  try {
    const stamp = statSync(transcriptPathFor(owner, root)).mtimeMs;
    return now - stamp < idleWindowMs(root) ? 'active' : 'gone';
  } catch {
    return 'unknown';
  }
}

export function ownerOf(task) {
  const owner = task?.owner;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

export function claimIsLive(task, now = Date.now(), root = null) {
  const owner = ownerOf(task);
  if (!owner) return false;

  const session = ownerSessionState(owner, root, now);
  if (session === 'gone') return false;
  if (session === 'active') return true;

  const claimedAt = Date.parse(String(task?.claimedAt ?? ''));
  // Porque una reserva sin fecha viene de una tarea escrita antes de este campo, se respeta
  // en vez de caducar al instante: tratarla como libre se la quitaría a quien la trabaja.
  if (Number.isNaN(claimedAt)) return true;
  return now - claimedAt < idleWindowMs(root);
}

export function blocksCaller(task, caller, now = Date.now(), root = null) {
  if (!claimIsLive(task, now, root)) return true;
  return Boolean(caller) && ownerOf(task) === caller;
}

export function ownedPathsOf(task) {
  return Array.isArray(task?.owns) ? task.owns.filter(Boolean).map(String) : [];
}
