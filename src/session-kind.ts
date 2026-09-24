/**
 * Session classification — Phase 150, D-01/D-02/D-04/D-37.
 *
 * A single, mechanical classifier used by every tool that needs to know what KIND of
 * session it is looking at: a session that belongs to a workout template ("template"), a
 * session recorded without one ("templateless"), or a QuickChallenge
 * (`isQuickChallenge`). The order is fixed and deliberate (D-01): `isQuickChallenge` is
 * checked FIRST — a QuickChallenge that also happens to carry a `templateId` is still
 * `quick_challenge`, never `template`. Group-workout sessions have no server-side
 * indicator distinguishing them from ordinary templateless training (Roadmap, deferred
 * idea in 150-CONTEXT.md) and are deliberately left in `templateless`.
 *
 * This module does NOT use `analysis/session-template-backfill.ts` — that module performs
 * similarity-based, ex-post assignment of a session to the template it most resembles.
 * D-01 forbids exactly that here: classification is mechanical (`templateId` set or not),
 * never inferred from content similarity.
 *
 * `templateStatus` (D-02) distinguishes a `template`-kind session whose template was
 * deleted (a tombstone with `deletedAt` present in the snapshot — including one the
 * server's tombstone GC removed after 90 days, `TombstoneGcService.kt`,
 * `GC_WINDOW_DAYS = 90`) from one whose template is simply absent from the snapshot (e.g.
 * a LOCAL_ONLY template that never synced). It is computed ONLY when the caller supplies
 * `templatesById` (via `buildTemplateIndex`) — a caller with no template index (the
 * per-row classification in `cache.ts`'s `decodeSessions`, which never fetches
 * `snapshot.templates`) gets `sessionKind` alone, no `templateStatus` field at all.
 *
 * `matchesSessionFilter` (D-04) is the get_history/get_progress filter predicate: it
 * matches `templateId` ONLY against `session.templateId` directly — it never requires the
 * referenced template to exist. An unknown `templateId` therefore filters to an empty
 * result, never an error.
 *
 * Exports:
 *   SESSION_KINDS, SessionKind, TemplateStatus — the shared vocabulary
 *   buildTemplateIndex   — SyncTemplateDto[] -> Map<id, dto>, including tombstones
 *   classifySession      — the D-01/D-02 classifier
 *   matchesSessionFilter — the D-04 filter predicate for get_history/get_progress
 */

import type { SyncTemplateDto } from './types.js';

/** The three session kinds a session can be classified into (D-01). */
export const SESSION_KINDS = ['template', 'templateless', 'quick_challenge'] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * Whether a `template`-kind session's template is still present and undeleted (`live`),
 * present but tombstoned (`deleted`), or absent from the snapshot entirely (`unknown` —
 * this also covers a template the server's tombstone GC removed 90 days after deletion).
 */
export type TemplateStatus = 'live' | 'deleted' | 'unknown';

/** The minimal session shape the classifier and filter need. */
export interface ClassifiableSession {
  templateId?: string;
  isQuickChallenge: boolean;
}

/**
 * Builds a lookup of every template in the snapshot BY ID, including tombstones
 * (`deletedAt` present) — the classifier needs tombstones present in this index to tell
 * "deleted" apart from "unknown" (D-02).
 */
export function buildTemplateIndex(templates: SyncTemplateDto[]): Map<string, SyncTemplateDto> {
  return new Map(templates.map((t) => [t.id, t]));
}

/**
 * Classifies one session, mechanically, in the fixed D-01 order:
 *   1. `isQuickChallenge` -> `quick_challenge` (even if `templateId` is also set)
 *   2. `templateId` set   -> `template` (+ `templateStatus`, D-02, only if `templatesById`
 *                            was supplied)
 *   3. otherwise          -> `templateless`
 *
 * @param session       The session (or a row's plaintext-only fields) to classify.
 * @param templatesById Optional template index (`buildTemplateIndex`). Omit this to get
 *                       `sessionKind` alone — used where no template snapshot is at hand
 *                       (e.g. `cache.ts`'s per-row `UnreadableRow` construction).
 */
export function classifySession(
  session: ClassifiableSession,
  templatesById?: Map<string, SyncTemplateDto>,
): { sessionKind: SessionKind; templateStatus?: TemplateStatus } {
  if (session.isQuickChallenge) {
    return { sessionKind: 'quick_challenge' };
  }

  if (session.templateId !== undefined) {
    if (templatesById === undefined) {
      return { sessionKind: 'template' };
    }
    const template = templatesById.get(session.templateId);
    const templateStatus: TemplateStatus =
      template === undefined ? 'unknown' : template.deletedAt !== undefined ? 'deleted' : 'live';
    return { sessionKind: 'template', templateStatus };
  }

  return { sessionKind: 'templateless' };
}

/**
 * The D-04 filter predicate for `get_history`/`get_progress`: AND-combines an optional
 * `templateId` match (direct on `session.templateId` — never requires the template to
 * exist, D-04) with an optional `sessionKind` match (via `classifySession`, without a
 * template index — `sessionKind` never depends on `templateStatus`). Both filters are
 * optional; an absent filter always matches.
 */
export function matchesSessionFilter(
  session: ClassifiableSession,
  filter: { templateId?: string; sessionKind?: SessionKind },
): boolean {
  if (filter.templateId !== undefined && session.templateId !== filter.templateId) {
    return false;
  }
  if (filter.sessionKind !== undefined) {
    const { sessionKind } = classifySession(session);
    if (sessionKind !== filter.sessionKind) {
      return false;
    }
  }
  return true;
}
