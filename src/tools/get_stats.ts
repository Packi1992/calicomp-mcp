/**
 * get_stats — computed training statistics tool.
 *
 * Returns app-consistent aggregates for an exercise or a muscle group:
 *   bestE1rm, totalVolume, avgVolumePerSession, setCount, sessionCount,
 *   firstSessionDate, lastSessionDate, trend (first vs last session e1RM, plus the
 *   full per-session point series — Phase 137, STATE-01, D-16).
 *
 * Exports:
 *   getStats(args, data)          — pure function; importable by Phase 121 WRITE tools
 *   registerToolGetStats(server, cfg) — registers the tool with the MCP server
 *
 * e1RM formula (D-01a):
 *   Mirrors WorkoutLoadCalculator.kt exactly — Epley variant with REP_CAP = 12.
 *   Must produce the same numbers as the app. Import from src/e1rm.ts; never re-implement.
 *
 * Muscle mapping (D-04a):
 *   catalog[].muscleGroups[].key (one of 18 canonical keys from MuscleGroupSeed.kt).
 *   An exercise matches the requested muscle if ANY of its muscleGroups has the matching key.
 *
 * Weighted muscle set count (Phase 138, MUSC-06, D-18):
 *   `GetStatsByMuscleResult.weightedSetCount` is an ADDITIVE field, not a replacement for
 *   the existing raw aggregate fields on `AggregatedStats` (set count, the reps × weight
 *   volume sum, etc). Those remain the physically honest raw values — the volume sum is a
 *   physical measurement, and multiplying a measurement by a subjective involvement-level
 *   factor would make the number unusable without anyone noticing at the call site.
 *   `weightedSetCount` sits next to them: for every matching set, the graded involvement
 *   level of the REQUESTED muscle on its exercise (via `weightFor` from
 *   `../training-state/muscle-balance.js` — the one stage→factor mapping in this repo,
 *   D-02) scales that set's contribution — PRIMARY in full, SECONDARY at half, STABILIZER
 *   at a quarter, an uncurated link at PRIMARY (D-03). `matchingExerciseIds` itself stays
 *   level-INDEPENDENT: an exercise that only stabilizes the requested muscle is still a
 *   matching exercise, because the level scales the weight, not the membership — narrowing
 *   membership would drop exercises the user genuinely performed from the answer. This
 *   makes this ONE of the four D-10 consumers additive while Radar (`muscle-balance.ts`),
 *   Ruzicka (`muscle-similarity.ts`), and the stretch/mobility heatmap REPLACE their
 *   unweighted computation outright — a deliberate asymmetry (D-18), not an oversight, so
 *   it should not be "fixed" on a later pass. `computeAggregates` (and therefore
 *   `getStatsByExercise`) is entirely unaware of `weightedSetCount` — the field exists
 *   ONLY on the muscle branch, because the exercise branch never asks about a muscle group
 *   and a field that would always equal the raw set count there would be pure noise in the
 *   LLM's context.
 *
 * Capability-axis breakdown (Phase 138.1, CAP-01/CAP-05, D-14):
 *   `{ by: 'capabilities' }` (`getStatsByCapabilities`) breaks down over ALL capability
 *   axes at once, with no further argument -- a deliberate asymmetry with the `muscle`
 *   branch (which requires a concrete muscle key and is therefore not really a
 *   "breakdown": the caller must already know what to ask about). It is its OWN function,
 *   never an extension of `getStatsByMuscle` or `computeAggregates` -- neither of those is
 *   touched by this branch, so no existing consumer's result silently changes shape. The
 *   folding math (stage -> factor) is imported from `capability-balance.js`'s
 *   `weightedCounts`, never re-implemented here (D-13: the weighting constants live in
 *   exactly one file). Every capability axis known anywhere in the catalog appears in the
 *   result, even with zero sets in the data -- an axis is never omitted, only shown with
 *   null/zero fields, so the coach can see that an axis did NOT occur, not just that it
 *   was not asked about.
 *
 * Security (threat model):
 *   T-120-17: catch → { isError:true }; never include key/PAT in error text
 *   T-120-18: no console.* anywhere — stdout is JSON-RPC only
 *   T-138-17: the raw reps × weight volume sum must never be scaled by an involvement-
 *             level factor — enforced by leaving `computeAggregates` untouched and adding
 *             `weightedSetCount` strictly alongside it, never inside it.
 *   T-138.1-41: no capability weighting constant lives in this file — the folding math is
 *               imported from `capability-balance.js`, never re-implemented here.
 *   T-138.1-42: `getStatsByCapabilities` is its own function; `getStatsByMuscle` and
 *               `getStatsByExercise` are untouched, so no existing consumer's result
 *               silently changes shape (additive extension, D-18 pattern).
 *
 * Patterns: RESEARCH.md §e1RM Formula, §Tool Registration API
 *           PATTERNS.md §src/tools/get_stats.ts lines 366–379
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetStatsSchema } from '../schemas.js';
import { getSnapshot } from '../cache.js';
import { bestE1rm } from '../e1rm.js';
import { weightFor } from '../training-state/muscle-balance.js';
import { weightedCounts as capabilityWeightedCounts } from '../training-state/capability-balance.js';
import type { CapabilityLevelSetCount } from '../training-state/capability-balance.js';
import type { DecryptedSnapshot, DecryptedSetLog, CatalogExercise } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GetStatsArgs =
  | { by: 'exercise'; exerciseId: string }
  | { by: 'muscle'; muscle: string }
  | { by: 'capabilities' };

/** Shared aggregate fields returned for both by-exercise and by-muscle queries. */
interface AggregatedStats {
  bestE1rm:             number | null;
  totalVolume:          number;
  avgVolumePerSession:  number;
  setCount:             number;
  sessionCount:         number;
  firstSessionDate:     string | null;   // ISO YYYY-MM-DD (UTC)
  lastSessionDate:      string | null;   // ISO YYYY-MM-DD (UTC)
  /**
   * Trend: bestE1rm of first vs last session, PLUS the full point series across every
   * touched session (Phase 137, STATE-01, D-16). `firstE1rm`, `lastE1rm` and `delta` keep
   * their exact pre-existing meaning, computation and shape — Phase 121's WRITE tools
   * import `getStats` as a function, and replacing them would be a contract break for
   * every existing importer. `points` sits ADDITIVELY next to them: the same per-session
   * `bestE1rm` computation the two-point delta already used, just carried for every
   * touched session instead of only the first and the last. A session whose sets are all
   * bodyweight/time-only still gets a point with `e1rm: null` — it is real proof that
   * training happened, not a gap to be silently dropped.
   */
  trend: {
    firstE1rm: number | null;
    lastE1rm:  number | null;
    delta:     number | null;            // lastE1rm - firstE1rm; null when either e1RM is null
    points: Array<{ date: string; sessionId: string; e1rm: number | null }>;
  } | null;
}

export interface GetStatsByExerciseResult extends AggregatedStats {
  by:         'exercise';
  exerciseId: string;
}

export interface GetStatsByMuscleResult extends AggregatedStats {
  by:                  'muscle';
  muscle:              string;
  matchingExerciseIds: string[];
  /**
   * Additive weighted set count (Phase 138, MUSC-06, D-18) — NOT a replacement for
   * `setCount`. Each matching set contributes `weightFor(involvementLevel)` of the
   * requested muscle group on its exercise, instead of a flat `1`. Lives ONLY on this
   * (muscle) branch; the exercise branch has no natural involvement level to weight by.
   */
  weightedSetCount:    number;
}

/** One capability axis's breakdown row within a `by:'capabilities'` result. */
export interface GetStatsByCapabilitiesAxis {
  key:                     string;
  nameEn:                  string;
  nameDe:                  string;
  /** Raw, unweighted set count for this axis — never scaled (D-18 pattern). */
  setCount:                number;
  /** Additive weighted set count (D-14/D-18) — folded via `capability-balance.js`'s
   *  `weightedCounts`, never a replacement for `setCount`. */
  weightedSetCount:        number;
  sessionCount:            number;
  contributingExerciseIds: string[];
  /** ISO YYYY-MM-DD (UTC) of the most recent session touching this axis, or null if none. */
  lastSessionDate:         string | null;
}

export interface GetStatsByCapabilitiesResult {
  by:   'capabilities';
  axes: GetStatsByCapabilitiesAxis[];
}

export type GetStatsResult = GetStatsByExerciseResult | GetStatsByMuscleResult | GetStatsByCapabilitiesResult;

// ---------------------------------------------------------------------------
// Shared aggregate computation
// ---------------------------------------------------------------------------

/**
 * Compute aggregate stats over a filtered set of set-logs.
 *
 * Volume: Σ completedReps × weightUsed over sets where both are positive.
 *         (bodyweight and time-only sets contribute 0 volume — same as the app).
 * setCount: total matched sets (including bodyweight).
 * Trend: bestE1rm per session for first and last chronological session.
 */
function computeAggregates(
  matchingSetLogs: DecryptedSetLog[],
  snapshot: DecryptedSnapshot,
): AggregatedStats {
  if (matchingSetLogs.length === 0) {
    return {
      bestE1rm:            null,
      totalVolume:         0,
      avgVolumePerSession: 0,
      setCount:            0,
      sessionCount:        0,
      firstSessionDate:    null,
      lastSessionDate:     null,
      trend:               null,
    };
  }

  // Identify unique sessions touched by these set-logs, sorted chronologically
  const touchedSessionIds = new Set<string>(matchingSetLogs.map(sl => sl.sessionId));
  const touchedSessions = snapshot.sessions
    .filter(s => touchedSessionIds.has(s.id))
    .sort((a, b) => a.startTime - b.startTime);

  const sessionCount = touchedSessions.length;

  // Best e1RM across ALL matched set-logs
  const overallBestE1rm = bestE1rm(matchingSetLogs);

  // Total volume: Σ reps × weight for weighted sets
  let totalVolume = 0;
  for (const sl of matchingSetLogs) {
    const w = sl.weightUsed;
    const r = sl.completedReps;
    if (w !== null && w > 0 && r !== null && r > 0) {
      totalVolume += r * w;
    }
  }

  const avgVolumePerSession = sessionCount > 0 ? totalVolume / sessionCount : 0;

  // First / last session dates (UTC ISO date)
  const firstSession = touchedSessions[0];
  const lastSession  = touchedSessions[touchedSessions.length - 1];
  const firstSessionDate = firstSession
    ? new Date(firstSession.startTime).toISOString().slice(0, 10)
    : null;
  const lastSessionDate = lastSession
    ? new Date(lastSession.startTime).toISOString().slice(0, 10)
    : null;

  // Trend: bestE1rm per touched session (D-16) — first and last carry forward the
  // pre-existing two-point delta unchanged; `points` is the same per-session bestE1rm
  // computation carried across every touched session, not just the first and the last.
  let trend: AggregatedStats['trend'] = null;
  if (touchedSessions.length > 0) {
    const points = touchedSessions.map(session => {
      const sessionLogs = matchingSetLogs.filter(sl => sl.sessionId === session.id);
      return {
        date:      new Date(session.startTime).toISOString().slice(0, 10),
        sessionId: session.id,
        e1rm:      bestE1rm(sessionLogs),
      };
    });
    const firstE1rm = points[0].e1rm;
    const lastE1rm  = points[points.length - 1].e1rm;
    const delta =
      firstE1rm !== null && lastE1rm !== null ? lastE1rm - firstE1rm : null;
    trend = { firstE1rm, lastE1rm, delta, points };
  }

  return {
    bestE1rm:            overallBestE1rm,
    totalVolume,
    avgVolumePerSession,
    setCount:            matchingSetLogs.length,
    sessionCount,
    firstSessionDate,
    lastSessionDate,
    trend,
  };
}

// ---------------------------------------------------------------------------
// by-exercise path
// ---------------------------------------------------------------------------

function getStatsByExercise(
  args: { by: 'exercise'; exerciseId: string },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsByExerciseResult {
  const matchingSetLogs = data.snapshot.setLogs.filter(
    sl => sl.exerciseId === args.exerciseId,
  );
  return {
    by:         'exercise',
    exerciseId: args.exerciseId,
    ...computeAggregates(matchingSetLogs, data.snapshot),
  };
}

// ---------------------------------------------------------------------------
// by-muscle path
// ---------------------------------------------------------------------------

function getStatsByMuscle(
  args: { by: 'muscle'; muscle: string },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsByMuscleResult {
  // Build list of catalog exercise IDs that include the requested muscle key
  // (D-04a: match catalog[].muscleGroups[].key). Membership stays level-independent —
  // a STABILIZER-only match still counts as a matching exercise (Phase 138, D-18).
  const matchingExerciseIds: string[] = [];
  // Phase 138 (MUSC-06, D-18): weight of the REQUESTED muscle group per matching exercise,
  // built once here rather than searching the catalog per set log.
  const weightByExerciseId = new Map<string, number>();
  for (const ex of data.catalog) {
    const muscleGroup = ex.muscleGroups.find(mg => mg.key === args.muscle);
    if (muscleGroup === undefined) continue;
    matchingExerciseIds.push(ex.id);
    weightByExerciseId.set(ex.id, weightFor(muscleGroup.involvementLevel));
  }

  const matchingExerciseIdSet = new Set<string>(matchingExerciseIds);
  const matchingSetLogs = data.snapshot.setLogs.filter(
    sl => sl.exerciseId !== undefined && matchingExerciseIdSet.has(sl.exerciseId!),
  );

  let weightedSetCount = 0;
  for (const sl of matchingSetLogs) {
    weightedSetCount += weightByExerciseId.get(sl.exerciseId!) ?? 0;
  }

  return {
    by:                  'muscle',
    muscle:              args.muscle,
    matchingExerciseIds,
    weightedSetCount,
    ...computeAggregates(matchingSetLogs, data.snapshot),
  };
}

// ---------------------------------------------------------------------------
// by-capabilities path (Phase 138.1, CAP-01/CAP-05, D-14)
// ---------------------------------------------------------------------------

/**
 * Breaks down training over ALL capability axes at once — a deliberate asymmetry with
 * `getStatsByMuscle` (D-14): the muscle branch requires a concrete argument and is
 * therefore not really a "breakdown", while this branch surfaces every axis the catalog
 * knows about with no prior knowledge required from the caller. This is its OWN function,
 * never an extension of `getStatsByMuscle` — that function and `computeAggregates` are
 * both untouched by this branch.
 */
function getStatsByCapabilities(data: {
  snapshot: DecryptedSnapshot;
  catalog: CatalogExercise[];
}): GetStatsByCapabilitiesResult {
  // Every capability axis known anywhere in the catalog, seeded with its EN/DE names
  // (falling back to the canonical key when a translation is missing, per D-05: axis
  // names travel over the database, not app string resources, so the coach must never
  // get back a nameless entry). An axis is registered here even if it never appears in
  // any set log below — the behavior block requires every known axis to appear in the
  // result, not just the ones touched in the data.
  const axisNames = new Map<string, { nameEn: string; nameDe: string }>();
  // Exercise id -> its capability axes, for O(1) lookup per matching set log. An exercise
  // with an empty `capabilities` array is never inserted, so it naturally contributes to
  // no axis below.
  const capabilitiesByExerciseId = new Map<string, CatalogExercise['capabilities']>();

  for (const ex of data.catalog) {
    if (ex.capabilities.length === 0) continue;
    capabilitiesByExerciseId.set(ex.id, ex.capabilities);
    for (const axis of ex.capabilities) {
      if (axisNames.has(axis.key)) continue;
      const nameEn = axis.translations.find(t => t.languageCode === 'en')?.name ?? axis.key;
      const nameDe = axis.translations.find(t => t.languageCode === 'de')?.name ?? axis.key;
      axisNames.set(axis.key, { nameEn, nameDe });
    }
  }

  interface AxisAccumulator {
    setCount: number;
    sessionIds: Set<string>;
    exerciseIds: Set<string>;
    lastSessionStart: number | null;
  }
  const accByAxis = new Map<string, AxisAccumulator>();
  const accumulatorFor = (key: string): AxisAccumulator => {
    let acc = accByAxis.get(key);
    if (acc === undefined) {
      acc = { setCount: 0, sessionIds: new Set(), exerciseIds: new Set(), lastSessionStart: null };
      accByAxis.set(key, acc);
    }
    return acc;
  };

  // Every graded row across every axis, for the ONE weightedCounts call below — the
  // folding math is imported from capability-balance.js and never re-implemented here
  // (D-13). Mirrors getStatsByMuscle's exerciseId-only matching (no workoutExerciseId
  // resolution) — the established get_stats.ts precedent this branch follows.
  const allRows: CapabilityLevelSetCount[] = [];
  const sessionById = new Map(data.snapshot.sessions.map(s => [s.id, s]));

  for (const setLog of data.snapshot.setLogs) {
    if (setLog.exerciseId === undefined) continue;
    const axes = capabilitiesByExerciseId.get(setLog.exerciseId);
    if (axes === undefined) continue;

    const session = sessionById.get(setLog.sessionId);

    for (const axis of axes) {
      allRows.push({ capabilityAxisKey: axis.key, capabilityLevel: axis.capabilityLevel, setCount: 1 });

      const acc = accumulatorFor(axis.key);
      acc.setCount += 1;
      acc.exerciseIds.add(setLog.exerciseId);
      if (session !== undefined) {
        acc.sessionIds.add(session.id);
        if (acc.lastSessionStart === null || session.startTime > acc.lastSessionStart) {
          acc.lastSessionStart = session.startTime;
        }
      }
    }
  }

  const weightedByAxis = capabilityWeightedCounts(allRows);

  const axes: GetStatsByCapabilitiesAxis[] = [];
  for (const [key, names] of axisNames) {
    const acc = accByAxis.get(key);
    axes.push({
      key,
      nameEn:                  names.nameEn,
      nameDe:                  names.nameDe,
      setCount:                acc?.setCount ?? 0,
      weightedSetCount:        weightedByAxis[key] ?? 0,
      sessionCount:            acc?.sessionIds.size ?? 0,
      contributingExerciseIds: acc !== undefined ? [...acc.exerciseIds] : [],
      lastSessionDate:
        acc?.lastSessionStart !== null && acc?.lastSessionStart !== undefined
          ? new Date(acc.lastSessionStart).toISOString().slice(0, 10)
          : null,
    });
  }

  return { by: 'capabilities', axes };
}

// ---------------------------------------------------------------------------
// Pure exportable function — importable by Phase 121 WRITE tools
// ---------------------------------------------------------------------------

/**
 * Compute training statistics for an exercise, muscle group, or the full capability-axis
 * breakdown.
 *
 * Overloaded (not a single widened signature) so a call site passing a literal
 * `{ by: 'exercise', ... }` / `{ by: 'muscle', ... }` argument keeps inferring its own
 * narrow result type — `GetStatsByExerciseResult/GetStatsByMuscleResult` still expose
 * `trend`/`totalVolume`/etc. directly, with no caller-side narrowing required. Adding the
 * `capabilities` variant (which shares no fields with `AggregatedStats`) to the return
 * union would otherwise force every EXISTING call site to narrow before touching a
 * field it already had — exactly the kind of silent, type-level break the plan's D-18
 * "existing branches stay unchanged" requirement guards against.
 *
 * @param args  Validated args from GetStatsSchema (discriminated union: by-exercise,
 *              by-muscle, or by-capabilities).
 * @param data  Decrypted snapshot + catalog from cache.
 */
export function getStats(
  args: { by: 'exercise'; exerciseId: string },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsByExerciseResult;
export function getStats(
  args: { by: 'muscle'; muscle: string },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsByMuscleResult;
export function getStats(
  args: { by: 'capabilities' },
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsByCapabilitiesResult;
// Dynamic-dispatch overload — for call sites (e.g. the MCP tool handler below) whose
// `args` is only known to be the general union at compile time (parsed from untyped
// JSON), not one of the three literal shapes above.
export function getStats(
  args: GetStatsArgs,
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsResult;
export function getStats(
  args: GetStatsArgs,
  data: { snapshot: DecryptedSnapshot; catalog: CatalogExercise[] },
): GetStatsResult {
  if (args.by === 'exercise') {
    return getStatsByExercise(args, data);
  }
  if (args.by === 'muscle') {
    return getStatsByMuscle(args, data);
  }
  return getStatsByCapabilities(data);
}

// ---------------------------------------------------------------------------
// Tool registration — used by src/index.ts (Phase 120-07)
// ---------------------------------------------------------------------------

/**
 * Register the `get_stats` tool with the MCP server.
 *
 * Naming convention (expected by 120-07 index.ts wiring):
 *   registerToolGetStats(server, { pat, keyB64, serverUrl })
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolGetStats(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'get_stats',
    {
      title:       'Get Training Stats',
      description:
        'Compute app-consistent training statistics (e1RM, volume, set/session counts, trend) ' +
        'for a specific exercise (`by: "exercise"`) or all exercises targeting a muscle group ' +
        '(`by: "muscle"`), or break down over every capability axis at once with no further ' +
        'argument (`by: "capabilities"` — balance, mobility, breath, etc.). e1RM uses the same ' +
        'Epley formula as the app. `trend.points` carries the full per-session e1RM series ' +
        'alongside the existing first-vs-last delta.',
      inputSchema: GetStatsSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const data   = await getSnapshot(pat, keyB64, serverUrl);
        const result = getStats(args as GetStatsArgs, {
          snapshot: data.snapshot,
          catalog:  data.catalog,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Stats error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
