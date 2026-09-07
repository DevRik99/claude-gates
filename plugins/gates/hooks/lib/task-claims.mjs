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

const CLAIM_TTL_HOURS = 8;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

export const CLAIM_TTL_MS =
  CLAIM_TTL_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export function ownerOf(task) {
  const owner = task?.owner;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

export function claimIsLive(task, now = Date.now()) {
  if (!ownerOf(task)) return false;
  const claimedAt = Date.parse(String(task?.claimedAt ?? ''));
  // Porque una reserva sin fecha viene de una tarea escrita antes de este campo, se respeta
  // en vez de caducar al instante: tratarla como libre se la quitaría a quien la trabaja.
  if (Number.isNaN(claimedAt)) return true;
  return now - claimedAt < CLAIM_TTL_MS;
}

export function blocksCaller(task, caller, now = Date.now()) {
  if (!claimIsLive(task, now)) return true;
  return Boolean(caller) && ownerOf(task) === caller;
}

export function ownedPathsOf(task) {
  return Array.isArray(task?.owns) ? task.owns.filter(Boolean).map(String) : [];
}
