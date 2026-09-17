/**
 * propose_planned_update — the coach's single tool for `planned_update` proposals
 * (D-01, Protocol v1.11 §2). One `z.discriminatedUnion('intent', [...])` — the coach
 * names an intent, a target and a date; THE MCP CODE (never the LLM) computes the
 * complete after-state root records the protocol's `planned_update` envelope carries.
 *
 * Four intents, all landing as one `planned_update` inbox card:
 *   - `move_occurrence`     (136-01, TRACER SLICE) — cancel-plus-create a single date.
 *   - `cancel_occurrence`   (136-02) — cancel a single date, or delete a standalone root.
 *   - `schedule_workout`    (136-02) — create a standalone or recurring root (D-03).
 *   - `change_series_rule`  (136-02) — replace a root's rule at `whole_series` scope, or
 *                             split it at a date (`this_and_following`, protocol §2's
 *                             "Splitting a series at a date" — the one piece of real
 *                             arithmetic in this phase).
 *
 * `move_occurrence` (protocol §2 "Moving a single occurrence") is modelled as
 * cancel-plus-create, never an in-place date mutation:
 *   - a recurring root: `replace` the original root (the moved date joins its
 *     deduplicated, ascending-sorted `deletedOccurrences`) + `create` a brand-new
 *     standalone root (`recurrenceRule: null`) at `newDate`, inheriting `templateId`
 *     and `scheduledTime` (overridden by `newTime` when supplied).
 *   - a non-recurring (standalone) root: one `replace` whose `scheduledDate` becomes
 *     `newDate` — nothing to cancel-plus-create against.
 *
 * `cancel_occurrence` mirrors the cancellation half of `move_occurrence` without the
 * create: a recurring root gets one `replace` with the date added to
 * `deletedOccurrences`; a standalone root — nothing left to recur, nothing to cancel a
 * date against — is `delete`d outright rather than emitting a `replace` carrying a
 * `deletedOccurrences` entry `expandDates` would never consult.
 *
 * `schedule_workout` emits exactly one `create` — a standalone root when no
 * `recurrenceRule` is supplied, a recurring root when one is (D-03). It carries
 * exactly one of `templateId` (an existing template) or `chainSuggestionId`
 * (Phase 136-08, D-04, protocol §2's "Proposal Chain Reference") — the id of the
 * coach's own still-open `new_plan` proposal to schedule against once it is accepted.
 * A supplied `chainSuggestionId` is resolved through the PAT-scoped read-back route
 * (`fetchSuggestion`, Plan 136-05) before any hashing or write call: it must belong to
 * the caller, name a `new_plan` proposal, and still be `pending` — resolving the chain
 * itself (writing a real `templateId` once the referenced proposal is accepted) is
 * Plan 136-09's job, not this one's.
 *
 * `change_series_rule` (protocol §2 "Splitting a series at a date"):
 *   - `whole_series`: one `replace` per affected root, `recurrenceRule` becomes
 *     `newRecurrenceRule`, `scheduledDate` untouched (no DTSTART-shift support in this
 *     plan).
 *   - `this_and_following`: the targeted root is cut at `cutoffDate` — `replace` the old
 *     root with `UNTIL` set to `cutoffDate - 1 day` (§3's `YYYYMMDD` form, nothing else
 *     about that rule changed) and `create` a fresh-UUID root on `cutoffDate` carrying
 *     `newRecurrenceRule`; `deletedOccurrences` partitions strictly-before/on-or-after
 *     the cutoff. A cutoff equal to the root's own `scheduledDate` collapses to a single
 *     `replace` — there is nothing "before" the cutoff to clamp.
 *   - Multi-root groups are indivisible (D-11, protocol §2): naming one root of a
 *     `recurrenceGroupId` group pulls in every member and splits them all at the same
 *     cutoff. A group whose resolved membership is not uniformly still part of the
 *     pattern (a member with no `recurrenceRule` — already detached, e.g. by an earlier
 *     `move_occurrence`) is rejected outright, never repaired.
 *
 * Rejections happen strictly BEFORE any hashing or WRITE network I/O, every one naming
 * a cause: an unknown `rootId`/`templateId`, an `occurrenceDate` outside the root's
 * expansion, a root with no `recurrenceRule` to change, a partial group, a
 * `recurrenceRule` the allowlist would reject (T-136-01/T-136-02/T-136-06/T-136-07/
 * T-136-08), or a `chainSuggestionId` that is foreign/unknown, not a `new_plan`, or no
 * longer `pending` (T-136-32/T-136-33, Phase 136-08) — a fabricated or malformed root
 * can never reach `postSuggest`. Resolving `chainSuggestionId` DOES make its own READ
 * call (`fetchSuggestion`) — "no network I/O" above means no WRITE call, never a byte
 * on the wire for a proposal the contract cannot express.
 *
 * Exports:
 *   buildMoveOccurrenceEnvelope(args, root)       — pure helper; move after-state builder
 *   buildCancelOccurrenceEnvelope(args, root)     — pure helper; cancel after-state builder
 *   buildScheduleWorkoutEnvelope(args)            — pure helper; schedule after-state builder
 *   buildChangeSeriesRuleEnvelope(args, members)  — pure helper; whole_series/split builder
 *   splitMemberAtCutoff(member, cutoffDate, rule) — pure helper; single-member split/collapse
 *                                                    (protocol §2 Rule 6, gap closure CR-01)
 *   proposePlannedUpdate(args, cfg)               — network-calling producer (getSnapshot,
 *                                                    validate, build, hash, postSuggest)
 *   registerToolProposePlannedUpdate(server, cfg) — registers the tool with the MCP server
 *
 * Security (threat model, 136-01-PLAN.md / 136-02-PLAN.md):
 *   T-136-01: `validateRRule` runs against the root's stored `recurrenceRule` before
 *             any hashing/network call — the single most safety-critical check this
 *             plan lands, proven by the corpus `rruleAllowlist` vectors.
 *   T-136-02: the MCP computes the after-state; the LLM never supplies root records.
 *             An unknown `rootId` or an out-of-expansion `occurrenceDate` is rejected
 *             with a named cause before `postSuggest`.
 *   T-136-03: `seriesHash` is a structural fingerprint, client-computed and
 *             server-trusted verbatim (never recomputed here or server-side).
 *   T-136-04: no error path interpolates `CALICOMP_KEY`/`CALICOMP_PAT`/ciphertext into
 *             a message (T-120-17/18 precedent).
 *   T-136-06: `schedule_workout`'s optional `recurrenceRule` runs through the SAME
 *             `validateRRule` gate as `change_series_rule` — a second create path never
 *             becomes a second, unguarded way to reach `expandDates`.
 *   T-136-07: the `this_and_following` split's `UNTIL` clamp is `cutoff - 1 day`, never
 *             the cutoff itself — an off-by-one here would double-book or drop the
 *             cutoff date silently (protocol §2).
 *   T-136-08: a partial `recurrenceGroupId` group is rejected outright, never repaired.
 *   T-121-04: only console.error permitted (ESLint no-console allow:['error']).
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProposePlannedUpdateSchema } from '../schemas.js';
import { getSnapshot, type SnapshotCache } from '../cache.js';
import { validateRRule, type RRuleRejectionCode } from '../rrule-allowlist.js';
import { computeSeriesHash, type SeriesHashRoot } from '../series-hash.js';
import { computeChangeHash } from '../hash.js';
import { getSourceLlm } from '../source_llm.js';
import { postSuggest, fetchSuggestion, HttpError } from '../http.js';
import {
  expandDates,
  parseDeletedOccurrences,
  parseIsoDate,
  formatIsoDate,
  epochMsToUtcCalDate,
  plusDays,
  compareCalDate,
  parseRRuleConfig,
} from '../recurrence.js';
import type { DecryptedPlannedWorkout } from '../types.js';

// ---------------------------------------------------------------------------
// Types (mirror ProposePlannedUpdateSchema — the Zod-validated shape of `args`)
// ---------------------------------------------------------------------------

export interface MoveOccurrenceArgs {
  intent: 'move_occurrence';
  rootId: string;
  occurrenceDate: string;
  newDate: string;
  newTime?: string;
  rationale: string;
}

export interface CancelOccurrenceArgs {
  intent: 'cancel_occurrence';
  rootId: string;
  occurrenceDate: string;
  rationale: string;
}

export interface ScheduleWorkoutArgs {
  intent: 'schedule_workout';
  templateId?: string;
  chainSuggestionId?: string;
  date: string;
  time?: string;
  recurrenceRule?: string;
  rationale: string;
}

export interface ChangeSeriesRuleArgs {
  intent: 'change_series_rule';
  rootId: string;
  scope: 'this_and_following' | 'whole_series';
  newRecurrenceRule: string;
  cutoffDate?: string;
  rationale: string;
}

export type ProposePlannedUpdateArgs =
  | MoveOccurrenceArgs
  | CancelOccurrenceArgs
  | ScheduleWorkoutArgs
  | ChangeSeriesRuleArgs;

/** A proposed root record on the wire — protocol §2 Root-Record Field Reference.
 * Every field is always present (possibly `null`) to match the protocol's own worked
 * examples byte-for-byte; `PlannedUpdateParser.parse` (Kotlin) accepts either shape
 * (explicit null or omitted key) since every optional field carries a `= null`
 * default, so this choice is presentation parity, not a decode requirement. */
export interface ProposedRootWire {
  id: string;
  /** Omitted (never `null`) for a `create` root carrying `chainSuggestionId` instead
   * (Phase 136-08, D-04) — every other operation/intent always sets this. */
  templateId?: string;
  /** Present only on a `schedule_workout` `create` root that names a still-open
   * `new_plan` proposal in place of a `templateId` (protocol §2 "Proposal Chain
   * Reference"). Omitted for every other root. */
  chainSuggestionId?: string;
  scheduledDate: string;
  scheduledTime: string | null;
  note: string | null;
  recurrenceRule: string | null;
  recurrenceGroupId: string | null;
  deletedOccurrences: string[];
}

export interface RootOperationWire {
  operation: 'create' | 'replace' | 'delete';
  root: ProposedRootWire;
}

export interface PlannedUpdateEnvelope {
  kind: 'occurrence' | 'rule';
  scope: 'this_occurrence' | 'this_and_following' | 'whole_series';
  roots: RootOperationWire[];
}

/**
 * Thrown for any rejection BEFORE hashing/network I/O — `cause` is a short, named,
 * secret-free identifier, never free text alone. The tool handler maps this to an
 * `isError` MCP response naming `cause`; `postSuggest` is never reached.
 */
export class PlannedUpdateRejection extends Error {
  constructor(
    public readonly cause:
      | 'ROOT_NOT_FOUND'
      | 'OCCURRENCE_NOT_IN_EXPANSION'
      | 'TEMPLATE_NOT_FOUND'
      | 'NO_RECURRENCE_RULE'
      | 'PARTIAL_GROUP_REJECTED'
      | 'MISSING_CUTOFF_DATE'
      | 'CHAIN_EXCLUSIVITY'
      | 'CHAIN_SUGGESTION_NOT_FOUND'
      | 'CHAIN_SUGGESTION_WRONG_TYPE'
      | 'CHAIN_SUGGESTION_NOT_PENDING'
      | 'RULE_NOT_EMITTABLE'
      | RRuleRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlannedUpdateRejection';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — importable/testable without MCP scaffolding or network access
// ---------------------------------------------------------------------------

/**
 * Build the move_occurrence after-state envelope (protocol §2 "Moving a single
 * occurrence") from the validated args and the root's before-state. Does NOT
 * validate `occurrenceDate` against the root's expansion or the root's
 * `recurrenceRule` against the allowlist — both happen in `proposePlannedUpdate`
 * before this is ever called, so this function is a pure, always-succeeding builder.
 */
export function buildMoveOccurrenceEnvelope(
  args: MoveOccurrenceArgs,
  root: DecryptedPlannedWorkout,
): PlannedUpdateEnvelope {
  const isRecurring = root.recurrenceRule !== null && root.recurrenceRule.trim() !== '';
  const existingDeleted = parseDeletedOccurrences(root.deletedOccurrencesRaw);
  const newScheduledTime = args.newTime ?? root.scheduledTime;

  if (!isRecurring) {
    // Standalone root: nothing to cancel-plus-create against — one `replace` moves
    // scheduledDate directly (protocol §2, second bullet of "Moving a single occurrence").
    const replaced: ProposedRootWire = {
      id: root.id,
      templateId: root.templateId,
      scheduledDate: args.newDate,
      scheduledTime: newScheduledTime,
      note: root.note,
      recurrenceRule: null,
      recurrenceGroupId: null,
      deletedOccurrences: existingDeleted,
    };
    return {
      kind: 'occurrence',
      scope: 'this_occurrence',
      roots: [{ operation: 'replace', root: replaced }],
    };
  }

  // Recurring root: cancel-plus-create (protocol §2).
  const newDeleted = Array.from(new Set([...existingDeleted, args.occurrenceDate])).sort();
  const originalScheduledDate = formatIsoDate(epochMsToUtcCalDate(root.scheduledDate));
  const originalRoot: ProposedRootWire = {
    id: root.id,
    templateId: root.templateId,
    scheduledDate: originalScheduledDate,
    scheduledTime: root.scheduledTime,
    note: root.note,
    recurrenceRule: root.recurrenceRule,
    recurrenceGroupId: root.recurrenceGroupId,
    deletedOccurrences: newDeleted,
  };
  const newRoot: ProposedRootWire = {
    id: randomUUID(),
    templateId: root.templateId,
    scheduledDate: args.newDate,
    scheduledTime: newScheduledTime,
    note: null,
    recurrenceRule: null,
    recurrenceGroupId: null,
    deletedOccurrences: [],
  };
  return {
    kind: 'occurrence',
    scope: 'this_occurrence',
    roots: [
      { operation: 'replace', root: originalRoot },
      { operation: 'create', root: newRoot },
    ],
  };
}

/**
 * Build the cancel_occurrence after-state envelope: a recurring root gets one
 * `replace` with `occurrenceDate` added to its deduplicated, ascending-sorted
 * `deletedOccurrences`; a standalone root — with no recurrence to cancel a date
 * against — is `delete`d outright rather than carrying a `deletedOccurrences` entry
 * `expandDates` would never consult. Does NOT itself validate `occurrenceDate` against
 * the root's expansion or the root's `recurrenceRule` against the allowlist — both
 * happen in `proposePlannedUpdate` before this is ever called.
 */
export function buildCancelOccurrenceEnvelope(
  args: CancelOccurrenceArgs,
  root: DecryptedPlannedWorkout,
): PlannedUpdateEnvelope {
  const isRecurring = root.recurrenceRule !== null && root.recurrenceRule.trim() !== '';
  const scheduledDate = formatIsoDate(epochMsToUtcCalDate(root.scheduledDate));

  if (!isRecurring) {
    const deleted: ProposedRootWire = {
      id: root.id,
      templateId: root.templateId,
      scheduledDate,
      scheduledTime: root.scheduledTime,
      note: root.note,
      recurrenceRule: null,
      recurrenceGroupId: null,
      deletedOccurrences: [],
    };
    return {
      kind: 'occurrence',
      scope: 'this_occurrence',
      roots: [{ operation: 'delete', root: deleted }],
    };
  }

  const existingDeleted = parseDeletedOccurrences(root.deletedOccurrencesRaw);
  const newDeleted = Array.from(new Set([...existingDeleted, args.occurrenceDate])).sort();
  const replaced: ProposedRootWire = {
    id: root.id,
    templateId: root.templateId,
    scheduledDate,
    scheduledTime: root.scheduledTime,
    note: root.note,
    recurrenceRule: root.recurrenceRule,
    recurrenceGroupId: root.recurrenceGroupId,
    deletedOccurrences: newDeleted,
  };
  return {
    kind: 'occurrence',
    scope: 'this_occurrence',
    roots: [{ operation: 'replace', root: replaced }],
  };
}

/**
 * Build the schedule_workout after-state envelope: exactly one `create` — a
 * standalone root when `recurrenceRule` is absent, a recurring root when present
 * (D-03). Carries exactly one of `templateId` or `chainSuggestionId` (Phase 136-08,
 * D-04) — `args` already carries exactly one, enforced by the schema's exclusivity
 * refinement, so this function only ever forwards whichever is present; it does NOT
 * itself validate `templateId` against the decrypted snapshot, resolve
 * `chainSuggestionId` against the caller's own proposals, or validate
 * `recurrenceRule` against the allowlist — all three happen in `proposePlannedUpdate`
 * before this is ever called.
 */
export function buildScheduleWorkoutEnvelope(args: ScheduleWorkoutArgs): PlannedUpdateEnvelope {
  // Spread conditionally, never assign `undefined` directly: `canonicalStringify`
  // (used by `computeChangeHash` over the whole envelope) refuses to serialize an
  // `undefined` value ANYWHERE in the object tree (G-134-37 precedent) — a key with
  // value `undefined` and an ABSENT key are not the same thing to it, even though
  // `JSON.stringify` alone would treat them identically.
  const created: ProposedRootWire = {
    id: randomUUID(),
    ...(args.templateId !== undefined ? { templateId: args.templateId } : {}),
    ...(args.chainSuggestionId !== undefined ? { chainSuggestionId: args.chainSuggestionId } : {}),
    scheduledDate: args.date,
    scheduledTime: args.time ?? null,
    note: null,
    recurrenceRule: args.recurrenceRule ?? null,
    recurrenceGroupId: null,
    deletedOccurrences: [],
  };
  return {
    kind: 'occurrence',
    scope: 'this_occurrence',
    roots: [{ operation: 'create', root: created }],
  };
}

/**
 * Append or replace ONLY the `UNTIL` parameter of an RRULE string, leaving every
 * other parameter untouched and in place (protocol §2, split field-level Rule 1/2).
 * `untilWire` is the already-formatted `YYYYMMDD` value.
 */
function replaceOrAppendUntil(rrule: string, untilWire: string): string {
  const parts = rrule.split(';');
  let found = false;
  const updated = parts.map((part) => {
    const eqIdx = part.indexOf('=');
    const key = eqIdx === -1 ? part : part.slice(0, eqIdx);
    if (key === 'UNTIL') {
      found = true;
      return `UNTIL=${untilWire}`;
    }
    return part;
  });
  if (!found) updated.push(`UNTIL=${untilWire}`);
  return updated.join(';');
}

/**
 * Split a single group member at `cutoffDate` (protocol §2 "Splitting a series at a
 * date", field-level rules 1-3/6). Rule 4 (grouped roots split together) is the
 * caller's responsibility — this function only ever sees one member at a time.
 *
 * Rule 6 (gap closure CR-01, plan `136-19`): when `cutoffDate` is on or before this
 * member's own `scheduledDate` (DTSTART) — not merely equal to it — no occurrence of
 * this member precedes the cutoff, so there is nothing to clamp and the member itself
 * IS the "following" half. Emits a single `replace` carrying the new rule directly,
 * unclamped, at the member's OWN `scheduledDate` — never a clamped root whose `UNTIL`
 * would precede its own start, and never a `create` anchored at a date earlier than the
 * member's intended start. This widens what was previously only an exact-match edge
 * case (`cutoffDate === scheduledDate`): a `recurrenceGroupId` group whose members have
 * staggered DTSTART values (a real shape — `CalendarViewModel.planAdvancedRecurrence`
 * builds such groups from different `weekOffset` entries) can therefore mix split
 * members (rules 1-3) and collapsed members (this rule) in the same envelope.
 *
 * Exported (not merely module-private, unlike this file's sibling helpers) so this
 * function's own three-case cutoff-boundary contract — cutoff after / equal to / before
 * a member's DTSTART — can be asserted directly, one member at a time
 * (`tests/tools/propose_planned_update.test.ts`). Widens no MCP tool surface: the
 * LLM-reachable registry entry (`registerToolProposePlannedUpdate`) is unchanged.
 */
export function splitMemberAtCutoff(
  member: DecryptedPlannedWorkout,
  cutoffDate: string,
  newRecurrenceRule: string,
): RootOperationWire[] {
  const cutoffCal = parseIsoDate(cutoffDate);
  const memberScheduledCal = epochMsToUtcCalDate(member.scheduledDate);
  const memberScheduledIso = formatIsoDate(memberScheduledCal);
  const existingDeleted = parseDeletedOccurrences(member.deletedOccurrencesRaw);
  const before = existingDeleted.filter((d) => compareCalDate(parseIsoDate(d), cutoffCal) < 0);
  const onOrAfter = existingDeleted.filter((d) => compareCalDate(parseIsoDate(d), cutoffCal) >= 0);

  if (compareCalDate(cutoffCal, memberScheduledCal) <= 0) {
    // Gap closure CR-01 (Task 2, 136-19): re-validate the coach-supplied
    // newRecurrenceRule against THIS root's own DTSTART before it is placed —
    // protocol §2 Rule 1's re-validation paragraph, Key Link now wired.
    assertRuleEmittableOnRoot(newRecurrenceRule, memberScheduledIso, member.id);
    const replaced: ProposedRootWire = {
      id: member.id,
      templateId: member.templateId,
      scheduledDate: memberScheduledIso,
      scheduledTime: member.scheduledTime,
      note: member.note,
      recurrenceRule: newRecurrenceRule,
      recurrenceGroupId: member.recurrenceGroupId,
      deletedOccurrences: onOrAfter,
    };
    return [{ operation: 'replace', root: replaced }];
  }

  // Rule 1: UNTIL is the day BEFORE the cutoff, never the cutoff itself — UNTIL is
  // inclusive in this dialect (T-136-07). Rule 2: the old root keeps its own id under
  // `replace`; the new root is a fresh UUID under `create`.
  const untilCal = plusDays(cutoffCal, -1);
  const untilWire = formatIsoDate(untilCal).replace(/-/g, '');
  const clampedRule = replaceOrAppendUntil(member.recurrenceRule as string, untilWire);
  // Gap closure CR-01 (Task 2): re-validate the DERIVED clamped rule against the old
  // root's own DTSTART — defense-in-depth, since Rule 1's UNTIL arithmetic keeps this
  // clamp on-or-after the member's own start by construction, but every rule the
  // builder is about to place on a root is checked here regardless of provenance.
  assertRuleEmittableOnRoot(clampedRule, memberScheduledIso, member.id);

  const oldRoot: ProposedRootWire = {
    id: member.id,
    templateId: member.templateId,
    scheduledDate: memberScheduledIso,
    scheduledTime: member.scheduledTime,
    note: member.note,
    recurrenceRule: clampedRule,
    recurrenceGroupId: member.recurrenceGroupId,
    deletedOccurrences: before,
  };
  // Rule 3: the new root inherits templateId/scheduledTime/recurrenceGroupId from the
  // member it split from, and carries the new rule.
  const newRootId = randomUUID();
  // Gap closure CR-01 (Task 2): re-validate the coach-supplied newRecurrenceRule
  // against the NEW root's own DTSTART (the cutoff) — the case that forces this guard
  // to cover caller-supplied rules, not only derived ones.
  assertRuleEmittableOnRoot(newRecurrenceRule, cutoffDate, newRootId);
  const newRoot: ProposedRootWire = {
    id: newRootId,
    templateId: member.templateId,
    scheduledDate: cutoffDate,
    scheduledTime: member.scheduledTime,
    note: null,
    recurrenceRule: newRecurrenceRule,
    recurrenceGroupId: member.recurrenceGroupId,
    deletedOccurrences: onOrAfter,
  };
  return [
    { operation: 'replace', root: oldRoot },
    { operation: 'create', root: newRoot },
  ];
}

/**
 * Build the change_series_rule after-state envelope for either scope. `members` is
 * the FULL resolved group (or a single-element array for a non-grouped root),
 * ordered by `scheduledDate` ascending — "group order" the roots array preserves
 * (`seriesHash`'s own by-id sort is independent of this array order).
 *
 * `whole_series`: one `replace` per member, `recurrenceRule` becomes
 * `newRecurrenceRule`, `scheduledDate` untouched (no DTSTART-shift support in this
 * plan). `this_and_following`: every member is split at `cutoffDate` (Rule 4 — grouped
 * roots split together) via `splitMemberAtCutoff`, in member order.
 */
export function buildChangeSeriesRuleEnvelope(
  args: ChangeSeriesRuleArgs,
  members: DecryptedPlannedWorkout[],
): PlannedUpdateEnvelope {
  if (args.scope === 'whole_series') {
    const roots: RootOperationWire[] = members.map((member) => {
      const memberScheduledIso = formatIsoDate(epochMsToUtcCalDate(member.scheduledDate));
      // Gap closure CR-01 (Task 2, 136-19): `whole_series` places ONE coach-supplied
      // newRecurrenceRule verbatim on EVERY member of a group — the case that forces
      // this guard to cover caller-supplied rules, not only derived ones. The same
      // string can be perfectly legal on the earliest member and leave a later member
      // inert; nothing complained about that before this check.
      assertRuleEmittableOnRoot(args.newRecurrenceRule, memberScheduledIso, member.id);
      return {
        operation: 'replace' as const,
        root: {
          id: member.id,
          templateId: member.templateId,
          scheduledDate: memberScheduledIso,
          scheduledTime: member.scheduledTime,
          note: member.note,
          recurrenceRule: args.newRecurrenceRule,
          recurrenceGroupId: member.recurrenceGroupId,
          deletedOccurrences: parseDeletedOccurrences(member.deletedOccurrencesRaw),
        },
      };
    });
    return { kind: 'rule', scope: 'whole_series', roots };
  }

  // scope === 'this_and_following' — cutoffDate presence is enforced by the caller
  // (Zod's superRefine on the schema, plus a runtime re-check in proposePlannedUpdate
  // for direct callers that bypass Zod) before this function is ever reached.
  const cutoffDate = args.cutoffDate as string;
  const roots: RootOperationWire[] = [];
  for (const member of members) {
    roots.push(...splitMemberAtCutoff(member, cutoffDate, args.newRecurrenceRule));
  }
  return { kind: 'rule', scope: 'this_and_following', roots };
}

// ---------------------------------------------------------------------------
// Shared before-state resolution helpers
// ---------------------------------------------------------------------------

function findRoot(data: SnapshotCache, rootId: string): DecryptedPlannedWorkout {
  const root = data.snapshot.plannedWorkouts.find((r) => r.id === rootId);
  if (!root) {
    throw new PlannedUpdateRejection('ROOT_NOT_FOUND', `Unknown rootId: ${rootId}`);
  }
  return root;
}

/**
 * T-136-01/PROP-08: validate a STORED `recurrenceRule` against the allowlist BEFORE
 * any expansion/hashing/network call — the rule was accepted at write time, but this
 * is an enforcement point Phase 136 owns for the MCP side (protocol §3), and never
 * trusting a stored value is the whole point of it.
 */
function validateStoredRule(root: DecryptedPlannedWorkout): void {
  const rruleCheck = validateRRule(root.recurrenceRule);
  if (!rruleCheck.valid) {
    throw new PlannedUpdateRejection(
      rruleCheck.reasonCode,
      `Stored recurrenceRule for root ${root.id} is rejected by the allowlist: ${rruleCheck.reasonCode}`,
    );
  }
}

/**
 * Gap closure CR-01 (plan `136-19`), protocol §2 Rule 1's re-validation paragraph and
 * §3's note on why `RULE_NOT_EMITTABLE` is not an allowlist-table row, and the
 * `136-VERIFICATION.md` Key Link (`splitMemberAtCutoff`/`buildChangeSeriesRuleEnvelope`
 * -> `validateRRule` ...) this task rewires from ✗ NOT WIRED to ✓ WIRED. Assert that
 * `rule` — a recurrence rule about to be placed on the root identified by `rootId`,
 * whose OWN DTSTART is `dtstartIso` — is emittable there: first the closed-set
 * allowlist (§3), then, when `rule` carries an `UNTIL`, that `UNTIL` must not precede
 * `dtstartIso`. A rule failing the allowlist throws with `validateRRule`'s own
 * `reasonCode` — the coach keeps the token-level diagnosis PROP-08 promises, and §3's
 * Rejection Table stays the only place token-keyed causes live. A rule that is
 * grammatically legal but inert on THIS root throws `PlannedUpdateRejection` with cause
 * `RULE_NOT_EMITTABLE` instead — no `DERIVED_` prefix, deliberately: this same helper
 * is called against the `whole_series` branch's caller-supplied `newRecurrenceRule` too,
 * so the cause names no provenance, because emittability is a property of the (rule,
 * root) pair, never of the rule's authorship. A rule with no `UNTIL` at all is always
 * emittable and this function returns without throwing.
 *
 * Deliberately module-private (unlike `splitMemberAtCutoff`, which Task 1 exports
 * because its own three-case contract is what its tests assert): every test that
 * reaches this guard does so only through `buildChangeSeriesRuleEnvelope`, which is
 * what makes those tests evidence the Key Link is wired, not merely that this function
 * works in isolation against a direct call.
 */
function assertRuleEmittableOnRoot(rule: string, dtstartIso: string, rootId: string): void {
  const rruleCheck = validateRRule(rule);
  if (!rruleCheck.valid) {
    throw new PlannedUpdateRejection(
      rruleCheck.reasonCode,
      `recurrenceRule "${rule}" for root ${rootId} is rejected by the allowlist: ${rruleCheck.reasonCode}`,
    );
  }
  const until = parseRRuleConfig(rule).until;
  if (until !== null && compareCalDate(parseIsoDate(until), parseIsoDate(dtstartIso)) < 0) {
    throw new PlannedUpdateRejection(
      'RULE_NOT_EMITTABLE',
      `recurrenceRule "${rule}" for root ${rootId} has UNTIL=${until}, which precedes its own ` +
        `scheduledDate ${dtstartIso} — this rule can never emit an occurrence on this root`,
    );
  }
}

/**
 * `ignoreDeleted` (cancel_occurrence only): confirms `occurrenceDate` is a date the
 * RRULE PATTERN would generate, regardless of whether it is already cancelled — an
 * empty excluded set, never the root's own `deletedOccurrences`. Without this, a date
 * already in `deletedOccurrences` would fail this check simply because `expandDates`
 * itself excludes it, contradicting the required idempotence of re-cancelling an
 * already-cancelled date (a `replace` whose `deletedOccurrences` contains it exactly
 * once, not twice — PROP-02). `move_occurrence` keeps the default (deletion-aware)
 * behavior — moving an already-cancelled occurrence is not a case this plan supports.
 */
function confirmOccurrence(
  root: DecryptedPlannedWorkout,
  occurrenceDate: string,
  options?: { ignoreDeleted?: boolean },
): void {
  const dtstart = epochMsToUtcCalDate(root.scheduledDate);
  const deletedSet = options?.ignoreDeleted ? new Set<string>() : new Set(parseDeletedOccurrences(root.deletedOccurrencesRaw));
  const occurrenceDateCal = parseIsoDate(occurrenceDate);
  const expansion = expandDates(dtstart, root.recurrenceRule, occurrenceDateCal, occurrenceDateCal, deletedSet, root.id);
  if (expansion.length === 0) {
    throw new PlannedUpdateRejection(
      'OCCURRENCE_NOT_IN_EXPANSION',
      `occurrenceDate ${occurrenceDate} is not an occurrence of root ${root.id}`,
    );
  }
}

/**
 * Resolve the full `recurrenceGroupId` membership of `root` from the decrypted
 * snapshot (protocol §2 "Multi-root groups are indivisible", D-11) — a non-grouped
 * root resolves to itself alone. Every resolved member must still carry a
 * `recurrenceRule` of its own: a member with none has already been detached from the
 * shared pattern (e.g. by an earlier `move_occurrence` turning it into a standalone
 * root), and splitting/replacing the group as if it were still whole would silently
 * clamp or replace a root that is no longer part of the pattern. Rejected outright —
 * T-136-08, never repaired. Members are returned sorted by `scheduledDate` ascending
 * ("group order" — `seriesHash`'s own by-id sort is independent of this).
 */
function resolveGroupMembers(data: SnapshotCache, root: DecryptedPlannedWorkout): DecryptedPlannedWorkout[] {
  if (root.recurrenceGroupId === null) return [root];

  const members = data.snapshot.plannedWorkouts
    .filter((r) => r.recurrenceGroupId === root.recurrenceGroupId)
    .slice()
    .sort((a, b) => a.scheduledDate - b.scheduledDate);

  const incomplete = members.find((m) => m.recurrenceRule === null || m.recurrenceRule.trim() === '');
  if (incomplete) {
    throw new PlannedUpdateRejection(
      'PARTIAL_GROUP_REJECTED',
      `recurrenceGroupId ${root.recurrenceGroupId} has member ${incomplete.id} with no recurrenceRule — ` +
        'multi-root groups are indivisible (protocol §2), refusing to split a partial group',
    );
  }
  return members;
}

/**
 * Resolve the STORED before-state root set for `envelope` per protocol §4 "Which State
 * Is Fingerprinted": every envelope-named root id that EXISTS in
 * `data.snapshot.plannedWorkouts`, plus every member of any `recurrenceGroupId` those
 * roots carry — mapped to the STORED row, never the envelope's proposed replacement.
 *
 * Deliberately does NOT reuse `findRoot`, which throws `ROOT_NOT_FOUND`: absence is the
 * normal case here (a `create` root has no stored row; a `schedule_workout` envelope
 * resolves to an empty list), not a rejection. Deliberately does NOT reuse
 * `resolveGroupMembers` either, which additionally enforces `PARTIAL_GROUP_REJECTED` —
 * that enforcement stays where it is, at the envelope builders, and must not be
 * duplicated into the hash path where it would turn a hashing concern into a rejection
 * concern.
 *
 * No tombstone filter is needed here and none is added: the snapshot the MCP receives
 * already excludes tombstones (133 D-03), which is exactly why §4 defines the set this
 * way.
 */
function resolveBeforeStateRoots(
  data: SnapshotCache,
  envelope: PlannedUpdateEnvelope,
): DecryptedPlannedWorkout[] {
  const ids = new Set<string>();
  const groupIds = new Set<string>();
  for (const op of envelope.roots) {
    ids.add(op.root.id);
    if (op.root.recurrenceGroupId !== null) {
      groupIds.add(op.root.recurrenceGroupId);
    }
  }
  for (const row of data.snapshot.plannedWorkouts) {
    if (row.recurrenceGroupId !== null && groupIds.has(row.recurrenceGroupId)) {
      ids.add(row.id);
    }
  }
  const rows: DecryptedPlannedWorkout[] = [];
  for (const id of ids) {
    const row = data.snapshot.plannedWorkouts.find((r) => r.id === id);
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Reduce a STORED root row to the `SeriesHashRoot` seven-field shape `computeSeriesHash`
 * hashes over (protocol §4). A straight seven-field pick — no date conversion, no
 * re-serialization: `row.scheduledDate` is already the raw stored epoch milliseconds and
 * `row.deletedOccurrencesRaw` is already the raw stored column text, precisely what §4's
 * encoding rules ask for. This is strictly simpler than the wire-root reducer it
 * replaces, which had to invent `epochDay(...) * 86_400_000` and a
 * `templateId`/`chainSuggestionId` substitute exactly because it was hashing a state
 * that does not exist in the database.
 */
function storedRootToSeriesHashRoot(row: DecryptedPlannedWorkout): SeriesHashRoot {
  return {
    id: row.id,
    templateId: row.templateId,
    scheduledDate: row.scheduledDate,
    scheduledTime: row.scheduledTime,
    recurrenceRule: row.recurrenceRule,
    recurrenceGroupId: row.recurrenceGroupId,
    deletedOccurrencesRaw: row.deletedOccurrencesRaw,
  };
}

// ---------------------------------------------------------------------------
// proposePlannedUpdate — the network-calling producer
// ---------------------------------------------------------------------------

export interface ProposePlannedUpdateConfig {
  pat: string;
  keyB64: string;
  serverUrl: string;
  sourceLlm: string;
}

/**
 * Resolve `args` against the current snapshot, validate every relevant rule against
 * the allowlist, build the after-state envelope for the named `intent`, compute its
 * `seriesHash`, and POST it as a `planned_update` proposal.
 *
 * Every rejection below happens BEFORE `computeSeriesHash`/`postSuggest` — never a
 * byte on the wire for an intent the contract cannot express.
 */
export async function proposePlannedUpdate(
  args: ProposePlannedUpdateArgs,
  cfg: ProposePlannedUpdateConfig,
): Promise<{ suggestionId: string; status: string }> {
  const data = await getSnapshot(cfg.pat, cfg.keyB64, cfg.serverUrl);

  let envelope: PlannedUpdateEnvelope;

  switch (args.intent) {
    case 'move_occurrence': {
      const root = findRoot(data, args.rootId);
      validateStoredRule(root);
      confirmOccurrence(root, args.occurrenceDate);
      envelope = buildMoveOccurrenceEnvelope(args, root);
      break;
    }

    case 'cancel_occurrence': {
      const root = findRoot(data, args.rootId);
      validateStoredRule(root);
      confirmOccurrence(root, args.occurrenceDate, { ignoreDeleted: true });
      envelope = buildCancelOccurrenceEnvelope(args, root);
      break;
    }

    case 'schedule_workout': {
      // Zod's superRefine on the schema enforces this exclusivity at the MCP request
      // boundary; this runtime re-check exists for direct callers that bypass Zod
      // (e.g. a raw handler test, or `proposePlannedUpdate` called directly) —
      // mirrors `change_series_rule`'s `cutoffDate` re-check below verbatim.
      if ((args.templateId === undefined) === (args.chainSuggestionId === undefined)) {
        throw new PlannedUpdateRejection(
          'CHAIN_EXCLUSIVITY',
          'schedule_workout requires exactly one of templateId or chainSuggestionId, never both, never neither',
        );
      }
      if (args.chainSuggestionId !== undefined) {
        // Phase 136-08, D-04: resolve the chain reference through the PAT-scoped
        // read-back route BEFORE any hashing or write call — T-136-32/T-136-33. A
        // foreign or unknown id both surface as `null` here (server no-leak 404,
        // T-118-05/T-133-02), so the two causes are structurally indistinguishable
        // and rejected with the same named cause.
        const referenced = await fetchSuggestion(cfg, args.chainSuggestionId);
        if (!referenced) {
          throw new PlannedUpdateRejection(
            'CHAIN_SUGGESTION_NOT_FOUND',
            `Unknown or foreign chainSuggestionId: ${args.chainSuggestionId}`,
          );
        }
        if (referenced.type !== 'new_plan') {
          throw new PlannedUpdateRejection(
            'CHAIN_SUGGESTION_WRONG_TYPE',
            `chainSuggestionId ${args.chainSuggestionId} does not reference a new_plan proposal (type: ${referenced.type})`,
          );
        }
        if (referenced.status !== 'pending') {
          throw new PlannedUpdateRejection(
            'CHAIN_SUGGESTION_NOT_PENDING',
            `chainSuggestionId ${args.chainSuggestionId} is no longer pending (status: ${referenced.status})`,
          );
        }
      } else {
        const template = data.snapshot.templates.find((t) => t.id === args.templateId);
        if (!template) {
          throw new PlannedUpdateRejection('TEMPLATE_NOT_FOUND', `Unknown templateId: ${args.templateId}`);
        }
      }
      // T-136-06: the allowlist guards THIS create path too, not only change_series_rule's.
      const rruleCheck = validateRRule(args.recurrenceRule);
      if (!rruleCheck.valid) {
        throw new PlannedUpdateRejection(
          rruleCheck.reasonCode,
          `recurrenceRule is rejected by the allowlist: ${rruleCheck.reasonCode}` +
            (rruleCheck.replacement !== null ? ` (permitted substitute: ${rruleCheck.replacement})` : ''),
        );
      }
      envelope = buildScheduleWorkoutEnvelope(args);
      break;
    }

    case 'change_series_rule': {
      const root = findRoot(data, args.rootId);
      if (root.recurrenceRule === null || root.recurrenceRule.trim() === '') {
        throw new PlannedUpdateRejection(
          'NO_RECURRENCE_RULE',
          `root ${args.rootId} has no recurrenceRule — there is no series to change`,
        );
      }
      const members = resolveGroupMembers(data, root);
      const rruleCheck = validateRRule(args.newRecurrenceRule);
      if (!rruleCheck.valid) {
        throw new PlannedUpdateRejection(
          rruleCheck.reasonCode,
          `newRecurrenceRule is rejected by the allowlist: ${rruleCheck.reasonCode}` +
            (rruleCheck.replacement !== null ? ` (permitted substitute: ${rruleCheck.replacement})` : ''),
        );
      }
      if (args.scope === 'this_and_following' && args.cutoffDate === undefined) {
        throw new PlannedUpdateRejection(
          'MISSING_CUTOFF_DATE',
          'cutoffDate is required when scope is this_and_following',
        );
      }
      envelope = buildChangeSeriesRuleEnvelope(args, members);
      break;
    }
  }

  const seriesHash = computeSeriesHash(resolveBeforeStateRoots(data, envelope).map(storedRootToSeriesHashRoot));
  const changeHash = computeChangeHash('planned_update', envelope);

  const result = await postSuggest(
    {
      type: 'planned_update',
      payload: JSON.stringify(envelope),
      rationale: args.rationale,
      sourceLlm: cfg.sourceLlm,
      changeHash,
      seriesHash,
    },
    cfg.pat,
    cfg.serverUrl,
  );
  return { suggestionId: result.id, status: result.status };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `propose_planned_update` tool with the MCP server.
 *
 * @param server  McpServer instance.
 * @param cfg     Runtime config: PAT, encryption key, server base URL.
 */
export function registerToolProposePlannedUpdate(
  server: McpServer,
  cfg: { pat: string; keyB64: string; serverUrl: string },
): void {
  const { pat, keyB64, serverUrl } = cfg;

  server.registerTool(
    'propose_planned_update',
    {
      title: 'Propose Planned Update',
      description:
        'Propose a change to the calendar for human review — name an intent, never a raw ' +
        'envelope. Four intents: move_occurrence (reschedule one occurrence, identified by ' +
        'rootId + occurrenceDate, to newDate), cancel_occurrence (cancel one occurrence, ' +
        'identified by rootId + occurrenceDate), schedule_workout (create a standalone or ' +
        'recurring root for templateId on date, optionally recurrenceRule), and ' +
        'change_series_rule (replace rootId\'s recurrence rule at scope whole_series or ' +
        'this_and_following — the latter requires cutoffDate and splits the series there). ' +
        'All root/template ids and dates come from get_planned_workouts. Rejects with a named ' +
        'cause — no network call — for an unknown root or template, an occurrenceDate that is ' +
        'not actually an occurrence of that root, a recurrence rule that fails allowlist ' +
        'validation, a root with no recurrence rule to change, or a recurrenceGroupId group ' +
        'that is not fully intact. Never mutates directly — the proposal is transported to the ' +
        'coach inbox for accept/reject.',
      inputSchema: ProposePlannedUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const typedArgs = args as ProposePlannedUpdateArgs;
        const sourceLlm = getSourceLlm(server);
        const result = await proposePlannedUpdate(typedArgs, { pat, keyB64, serverUrl, sourceLlm });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof PlannedUpdateRejection) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${err.cause}: ${err.message}` }],
          };
        }
        if (err instanceof HttpError) {
          console.error(`propose_planned_update: server ${err.status}`);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Server rejected proposal: HTTP ${err.status}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Propose planned update error: ${(err as Error).message}` }],
        };
      }
    },
  );
}
