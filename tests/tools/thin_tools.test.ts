/**
 * Tests for the four "thin" read tools:
 *   get_profile, list_templates, get_template, get_exercise_catalog
 *
 * Coverage mirrors the <behavior> blocks from 120-07-PLAN.md:
 *   - get_profile:       returns the profile object unchanged (passthrough)
 *   - list_templates:    excludes deletedAt!=null; correct blockCount/exerciseCount
 *   - get_template:      joins blocks+templateExercises by templateId;
 *                        unknown id → null from pure handler (→ isError in register fn);
 *                        bad UUID → GetTemplateSchema rejects
 *   - get_exercise_catalog: always includes muscleGroups[].key;
 *                           adds localizedName when lang matches a translation;
 *                           falls back to nameEn when no translation found
 *
 * Pure handler functions are tested directly against the fixture.
 * The registered MCP handler is tested for the unknown-id isError path
 * (requires mocking getSnapshot).
 *
 * Fixture key values:
 *   TEMPLATE_ID_PUSH — 'Push Day', 1 block (BLOCK_ID_PUSH_A), 2 TEs (pushup+pullup)
 *   TEMPLATE_ID_LEGS — 'Leg Day',  1 block (BLOCK_ID_LEGS_A),  1 TE  (squat)
 *   mockCatalog[0]   — Push-Up (muscleGroups: chest, back); 'de' translation: 'Liegestütz'
 *   mockCatalog[1]   — Pull-Up (muscleGroups: back, lats);  'de' translation: 'Klimmzug'
 *   mockCatalog[2]   — Squat   (muscleGroups: quads, glutes); 'de' translation: 'Kniebeuge'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Module mocks — hoisted before static imports by Vitest.
// Only the isError/handler tests use the mocked getSnapshot;
// pure-function tests call handlers directly and never trigger it.
vi.mock('../../src/cache.js');

import * as cacheModule from '../../src/cache.js';
import { GetTemplateSchema } from '../../src/schemas.js';
import { getProfile }          from '../../src/tools/get_profile.js';
import { listTemplates }        from '../../src/tools/list_templates.js';
import { getTemplate }          from '../../src/tools/get_template.js';
import { getExerciseCatalog }   from '../../src/tools/get_exercise_catalog.js';
import { registerToolGetTemplate } from '../../src/tools/get_template.js';

import type { UserProfileResponse } from '../../src/types.js';
import {
  mockSnapshot,
  mockCatalog,
  TEMPLATE_ID_PUSH,
  TEMPLATE_ID_LEGS,
  BLOCK_ID_PUSH_A,
  BLOCK_ID_LEGS_A,
  TE_ID_PUSH_PUSHUP,
  TE_ID_PUSH_PULLUP,
  TE_ID_LEGS_SQUAT,
} from '../fixture.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const mockProfile: UserProfileResponse = {
  userId:      'user-test-1',
  email:       'test@example.com',
  displayName: 'Test User',
  avatarUrl:   'https://example.com/avatar.svg',
  isPremium:   false,
  createdAt:   1_700_000_000_000,
};

/** Full SnapshotCache shape returned by mocked getSnapshot. */
const MOCK_CACHE = {
  snapshot:  mockSnapshot,
  catalog:   mockCatalog,
  profile:   mockProfile,
  fetchedAt: Date.now(),
};

const DUMMY_CFG = { pat: 'calicomp_pat_test', keyB64: 'AAAA', serverUrl: 'https://example.test' };

const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

// ---------------------------------------------------------------------------
// get_profile
// ---------------------------------------------------------------------------

describe('getProfile — pure handler', () => {
  it('returns the profile object unchanged (passthrough)', () => {
    const result = getProfile(mockProfile);
    expect(result).toStrictEqual(mockProfile);
  });

  it('result is JSON-parseable', () => {
    const result = getProfile(mockProfile);
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).email).toBe('test@example.com');
  });
});

// ---------------------------------------------------------------------------
// list_templates
// ---------------------------------------------------------------------------

describe('listTemplates — pure handler', () => {
  it('returns both non-deleted templates from the fixture', () => {
    const result = listTemplates(mockSnapshot);
    expect(result).toHaveLength(2);
    const ids = result.map(t => t.id);
    expect(ids).toContain(TEMPLATE_ID_PUSH);
    expect(ids).toContain(TEMPLATE_ID_LEGS);
  });

  it('computes correct blockCount and exerciseCount for Push Day', () => {
    const result = listTemplates(mockSnapshot);
    const push = result.find(t => t.id === TEMPLATE_ID_PUSH);
    expect(push).toBeDefined();
    expect(push!.blockCount).toBe(1);    // BLOCK_ID_PUSH_A
    expect(push!.exerciseCount).toBe(2); // pushup + pullup
  });

  it('computes correct blockCount and exerciseCount for Leg Day', () => {
    const result = listTemplates(mockSnapshot);
    const legs = result.find(t => t.id === TEMPLATE_ID_LEGS);
    expect(legs).toBeDefined();
    expect(legs!.blockCount).toBe(1);   // BLOCK_ID_LEGS_A
    expect(legs!.exerciseCount).toBe(1); // squat
  });

  it('excludes templates with a non-null deletedAt', () => {
    // Build a snapshot with one deleted template
    const snapshotWithDeleted = {
      ...mockSnapshot,
      templates: [
        ...mockSnapshot.templates,
        {
          id:                 'deleted-tmpl-1111-1111-111111111111',
          name:               'Deleted Template',
          createdAt:          1_700_000_000_000,
          updatedAt:          1_700_000_000_000,
          deletedAt:          1_710_000_000_000, // soft-deleted
          isFavoriteForWatch: false,
        },
      ],
    };
    const result = listTemplates(snapshotWithDeleted);
    expect(result).toHaveLength(2); // only the two non-deleted ones
    const ids = result.map(t => t.id);
    expect(ids).not.toContain('deleted-tmpl-1111-1111-111111111111');
  });

  it('result is JSON-parseable', () => {
    const result = listTemplates(mockSnapshot);
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes workoutType when the snapshot carries it (Phase 134, G-134-12)', () => {
    const snapshotWithFormat = {
      ...mockSnapshot,
      templates: [
        {
          ...mockSnapshot.templates[0],
          workoutType: 'CIRCUIT',
          formatParams: '{"rounds":3}',
        },
        mockSnapshot.templates[1],
      ],
    };
    const result = listTemplates(snapshotWithFormat);
    const circuit = result.find(t => t.id === TEMPLATE_ID_PUSH);
    expect(circuit!.workoutType).toBe('CIRCUIT');
    // formatParams is deliberately not projected into the list item.
    expect('formatParams' in circuit!).toBe(false);
  });

  it('omits workoutType key when the snapshot does not carry it', () => {
    const result = listTemplates(mockSnapshot);
    const push = result.find(t => t.id === TEMPLATE_ID_PUSH);
    expect('workoutType' in push!).toBe(false);
  });

  // CR-01 (134-REVIEW.md): the server can legitimately emit a literal wire `null` for
  // `workoutType` — not merely an absent key — for any row whose column has not been
  // (re-)written since the format-params migration lands (no backfill). A strict
  // `!== undefined` check let that `null` through verbatim into the projected item.
  it('omits workoutType key when the snapshot carries a genuine null (not merely absent)', () => {
    const snapshotWithNullWorkoutType = {
      ...mockSnapshot,
      templates: [
        { ...mockSnapshot.templates[0], workoutType: null },
        mockSnapshot.templates[1],
      ],
    };
    const result = listTemplates(snapshotWithNullWorkoutType);
    const push = result.find(t => t.id === TEMPLATE_ID_PUSH);
    expect('workoutType' in push!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_template
// ---------------------------------------------------------------------------

describe('getTemplate — pure handler', () => {
  it('returns TemplateDetail with correct blocks and templateExercises for Push Day', () => {
    const result = getTemplate({ templateId: TEMPLATE_ID_PUSH }, mockSnapshot);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(TEMPLATE_ID_PUSH);
    expect(result!.name).toBe('Push Day');
    expect(result!.isFavoriteForWatch).toBe(true);

    // One block: BLOCK_ID_PUSH_A
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0].id).toBe(BLOCK_ID_PUSH_A);
    expect(result!.blocks[0].templateId).toBe(TEMPLATE_ID_PUSH);

    // Two templateExercises: pushup + pullup
    expect(result!.templateExercises).toHaveLength(2);
    const teIds = result!.templateExercises.map(te => te.id);
    expect(teIds).toContain(TE_ID_PUSH_PUSHUP);
    expect(teIds).toContain(TE_ID_PUSH_PULLUP);
  });

  it('returns TemplateDetail with correct blocks and templateExercises for Leg Day', () => {
    const result = getTemplate({ templateId: TEMPLATE_ID_LEGS }, mockSnapshot);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0].id).toBe(BLOCK_ID_LEGS_A);
    expect(result!.templateExercises).toHaveLength(1);
    expect(result!.templateExercises[0].id).toBe(TE_ID_LEGS_SQUAT);
  });

  it('returns null for an unknown templateId', () => {
    const result = getTemplate({ templateId: UNKNOWN_UUID }, mockSnapshot);
    expect(result).toBeNull();
  });

  it('result is JSON-parseable', () => {
    const result = getTemplate({ templateId: TEMPLATE_ID_PUSH }, mockSnapshot);
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes workoutType and formatParams when the snapshot carries them (Phase 134, G-134-12)', () => {
    const snapshotWithFormat = {
      ...mockSnapshot,
      templates: [
        {
          ...mockSnapshot.templates[0],
          workoutType: 'CIRCUIT',
          formatParams: '{"rounds":3,"restSeconds":45,"exercises":[]}',
        },
        mockSnapshot.templates[1],
      ],
    };
    const result = getTemplate({ templateId: TEMPLATE_ID_PUSH }, snapshotWithFormat);
    expect(result!.workoutType).toBe('CIRCUIT');
    expect(result!.formatParams).toBe('{"rounds":3,"restSeconds":45,"exercises":[]}');
  });

  it('omits workoutType and formatParams keys when the snapshot does not carry them', () => {
    const result = getTemplate({ templateId: TEMPLATE_ID_PUSH }, mockSnapshot);
    expect('workoutType' in result!).toBe(false);
    expect('formatParams' in result!).toBe(false);
  });

  // CR-01 (134-REVIEW.md): once the format-params migration deploys, a template row
  // the user has not re-synced since then keeps its column at the server's genuine wire
  // `null` (no backfill, no explicitNulls=false) — this is NOT the same runtime shape as
  // the key being absent, and a strict `!== undefined` check let it through unnormalized,
  // wrongly causing `format_proposal.ts`'s `classicOps` fallback to be missed downstream.
  it('omits workoutType and formatParams keys when the snapshot carries a genuine null (not merely absent)', () => {
    const snapshotWithNullFormatFields = {
      ...mockSnapshot,
      templates: [
        { ...mockSnapshot.templates[0], workoutType: null, formatParams: null },
        mockSnapshot.templates[1],
      ],
    };
    const result = getTemplate({ templateId: TEMPLATE_ID_PUSH }, snapshotWithNullFormatFields);
    expect('workoutType' in result!).toBe(false);
    expect('formatParams' in result!).toBe(false);
  });
});

describe('getTemplate — schema validation', () => {
  it('rejects a non-UUID templateId', () => {
    const parse = GetTemplateSchema.safeParse({ templateId: 'not-a-valid-uuid' });
    expect(parse.success).toBe(false);
  });

  it('accepts a valid RFC 4122 UUID templateId', () => {
    // Use CATALOG_EXERCISE_ID_PUSHUP which has variant byte 'a' (valid RFC 4122)
    // TEMPLATE_ID_PUSH has variant byte 'c' which is outside [89ab] — not RFC 4122.
    // Schema validation only; this UUID does not need to match a real template.
    const parse = GetTemplateSchema.safeParse({ templateId: UNKNOWN_UUID });
    expect(parse.success).toBe(true);
  });
});

describe('getTemplate — registered MCP handler (unknown-id → isError)', () => {
  beforeEach(() => {
    vi.mocked(cacheModule.getSnapshot).mockResolvedValue(MOCK_CACHE);
  });

  it('registered handler returns isError: true for unknown templateId', async () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    registerToolGetTemplate(server, DUMMY_CFG);

    // Access the registered handler via the internal SDK map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (server as any)._registeredTools['get_template'].handler as (
      args: { templateId: string }
    ) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

    const result = await handler({ templateId: UNKNOWN_UUID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(UNKNOWN_UUID);
  });
});

// ---------------------------------------------------------------------------
// get_exercise_catalog
// ---------------------------------------------------------------------------

describe('getExerciseCatalog — pure handler', () => {
  it('returns all catalog exercises unchanged when lang is not provided', () => {
    const result = getExerciseCatalog({}, mockCatalog);
    expect(result).toHaveLength(3);
  });

  it('all exercises include muscleGroups[].key', () => {
    const result = getExerciseCatalog({}, mockCatalog);
    for (const ex of result) {
      expect(ex.muscleGroups.length).toBeGreaterThan(0);
      for (const mg of ex.muscleGroups) {
        expect(typeof mg.key).toBe('string');
        expect(mg.key.length).toBeGreaterThan(0);
      }
    }
  });

  it('adds localizedName from matching translation when lang is provided', () => {
    const result = getExerciseCatalog({ lang: 'de' }, mockCatalog);
    const pushUp = result.find(ex => ex.key === 'push_up');
    expect(pushUp).toBeDefined();
    expect(pushUp!.localizedName).toBe('Liegestütz');
  });

  it('falls back to nameEn when no translation exists for requested lang', () => {
    const result = getExerciseCatalog({ lang: 'fr' }, mockCatalog); // no French in fixture
    for (const ex of result) {
      // localizedName should be the English name when no French translation exists
      expect(ex.localizedName).toBe(ex.nameEn);
    }
  });

  it('does not add localizedName when lang is not provided', () => {
    const result = getExerciseCatalog({}, mockCatalog);
    for (const ex of result) {
      expect((ex as { localizedName?: string }).localizedName).toBeUndefined();
    }
  });

  it('result is JSON-parseable', () => {
    const result = getExerciseCatalog({ lang: 'de' }, mockCatalog);
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
