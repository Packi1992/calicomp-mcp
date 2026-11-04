/**
 * The sentence every `propose_*` tool description ends with (Phase 168, plan 168-05, D-10, protocol 1.56 §5
 * "Direct application by the app"). The coach is told that the app may apply a proposal directly, never how the
 * athlete set it; the sentence names no setting. `tests/auto-apply-notice.test.ts` compares this constant with the
 * verbatim block `AUTO_APPLY_NOTICE` of docs/COACH-PLANNING-PROTOCOL.md character for character.
 */
export const AUTO_APPLY_NOTICE =
  'Depending on the settings of the athlete, the app may apply this proposal directly; get_suggestions shows afterwards whether it was applied automatically or undone.';
