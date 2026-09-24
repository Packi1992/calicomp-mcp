/**
 * Tests for src/session-kind.ts (Phase 150, D-01/D-02/D-04/D-37).
 *
 * Coverage:
 *   - classifySession: the fixed D-01 order (isQuickChallenge first, then templateId,
 *     then templateless), and templateStatus (D-02) only when a template index is given.
 *   - matchesSessionFilter: templateId matched directly, sessionKind matched via
 *     classifySession, both optional and AND-combined; never requires the template to
 *     exist (D-04).
 */

import { describe, it, expect } from 'vitest';
import { buildTemplateIndex, classifySession, matchesSessionFilter } from '../src/session-kind.js';
import type { SyncTemplateDto } from '../src/types.js';

const LIVE_TEMPLATE: SyncTemplateDto = {
  id: 'tpl-live',
  name: 'Push Day',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  isFavoriteForWatch: false,
};

const DELETED_TEMPLATE: SyncTemplateDto = {
  id: 'tpl-deleted',
  name: 'Old Leg Day',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  deletedAt: 1_700_000_100_000,
  isFavoriteForWatch: false,
};

describe('classifySession', () => {
  it('P150 D-01 a quick challenge with a templateId is quick_challenge', () => {
    const result = classifySession({ templateId: 'tpl-live', isQuickChallenge: true });
    expect(result).toEqual({ sessionKind: 'quick_challenge' });
  });

  it('P150 D-01 a session with templateId and no quick flag is template', () => {
    const result = classifySession({ templateId: 'tpl-live', isQuickChallenge: false });
    expect(result.sessionKind).toBe('template');
  });

  it('P150 D-01 a session without templateId is templateless', () => {
    const result = classifySession({ isQuickChallenge: false });
    expect(result).toEqual({ sessionKind: 'templateless' });
  });

  it('does not compute templateStatus when no template index is supplied', () => {
    const result = classifySession({ templateId: 'tpl-live', isQuickChallenge: false });
    expect(result).toEqual({ sessionKind: 'template' });
    expect(result.templateStatus).toBeUndefined();
  });

  it('P150 D-02 a tombstoned template yields templateStatus deleted', () => {
    const templatesById = buildTemplateIndex([DELETED_TEMPLATE]);
    const result = classifySession({ templateId: 'tpl-deleted', isQuickChallenge: false }, templatesById);
    expect(result).toEqual({ sessionKind: 'template', templateStatus: 'deleted' });
  });

  it('P150 D-02 a template missing from the snapshot yields templateStatus unknown', () => {
    const templatesById = buildTemplateIndex([LIVE_TEMPLATE]);
    const result = classifySession({ templateId: 'tpl-nowhere', isQuickChallenge: false }, templatesById);
    expect(result).toEqual({ sessionKind: 'template', templateStatus: 'unknown' });
  });

  it('a live, present template yields templateStatus live', () => {
    const templatesById = buildTemplateIndex([LIVE_TEMPLATE]);
    const result = classifySession({ templateId: 'tpl-live', isQuickChallenge: false }, templatesById);
    expect(result).toEqual({ sessionKind: 'template', templateStatus: 'live' });
  });

  it('a quick challenge with a templateId never carries templateStatus, even with an index', () => {
    const templatesById = buildTemplateIndex([LIVE_TEMPLATE]);
    const result = classifySession({ templateId: 'tpl-live', isQuickChallenge: true }, templatesById);
    expect(result).toEqual({ sessionKind: 'quick_challenge' });
  });
});

describe('matchesSessionFilter', () => {
  it('matches nothing filtered when both filters are absent', () => {
    expect(matchesSessionFilter({ templateId: 'tpl-live', isQuickChallenge: false }, {})).toBe(true);
  });

  it('templateId matches directly on session.templateId, never requiring the template to exist', () => {
    expect(
      matchesSessionFilter(
        { templateId: 'tpl-nowhere', isQuickChallenge: false },
        { templateId: 'tpl-nowhere' },
      ),
    ).toBe(true);
    expect(
      matchesSessionFilter({ templateId: 'tpl-live', isQuickChallenge: false }, { templateId: 'tpl-other' }),
    ).toBe(false);
  });

  it('sessionKind matches via classifySession without a template index', () => {
    expect(
      matchesSessionFilter({ templateId: 'tpl-live', isQuickChallenge: false }, { sessionKind: 'template' }),
    ).toBe(true);
    expect(
      matchesSessionFilter({ isQuickChallenge: false }, { sessionKind: 'templateless' }),
    ).toBe(true);
    expect(
      matchesSessionFilter({ isQuickChallenge: true }, { sessionKind: 'template' }),
    ).toBe(false);
  });

  it('AND-combines templateId and sessionKind', () => {
    expect(
      matchesSessionFilter(
        { templateId: 'tpl-live', isQuickChallenge: false },
        { templateId: 'tpl-live', sessionKind: 'template' },
      ),
    ).toBe(true);
    expect(
      matchesSessionFilter(
        { templateId: 'tpl-live', isQuickChallenge: false },
        { templateId: 'tpl-live', sessionKind: 'templateless' },
      ),
    ).toBe(false);
  });
});
