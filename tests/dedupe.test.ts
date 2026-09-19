/**
 * Tests for src/dedupe.ts
 *
 * Coverage:
 *   - normalizeExerciseName: trim, case, whitespace-collapse, accent-fold parity vectors
 *     against ExerciseNameNormalizer.kt semantics (RESEARCH.md Pattern 6)
 *   - findCatalogMatch: EN-name match, translation-name match (cross-language), no-match,
 *     empty-input
 */

import { describe, it, expect } from 'vitest';
import { normalizeExerciseName, findCatalogMatch } from '../src/dedupe.js';
import { mockCatalog, CATALOG_EXERCISE_ID_PULLUP } from './fixture.js';

// ---------------------------------------------------------------------------
// normalizeExerciseName — parity vectors vs ExerciseNameNormalizer.kt
// ---------------------------------------------------------------------------

describe('normalizeExerciseName', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeExerciseName('  Klimmzug  ')).toBe('klimmzug');
  });

  it('lowercases (fixed en-US locale)', () => {
    expect(normalizeExerciseName('Klimmzug')).toBe('klimmzug');
    expect(normalizeExerciseName('KLIMMZUG')).toBe('klimmzug');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeExerciseName('Klimm  zug')).toBe('klimm zug');
    expect(normalizeExerciseName('Klimm\t\tzug')).toBe('klimm zug');
  });

  it('produces the same normalized key for trim/case/whitespace variants', () => {
    const key = normalizeExerciseName('Klimmzug');
    expect(normalizeExerciseName('klimmzug')).toBe(key);
    expect(normalizeExerciseName('  Klimmzug  ')).toBe(key);
  });

  it('folds accents via NFD + Mn-strip (ü -> u)', () => {
    expect(normalizeExerciseName('Klimmzüg')).toBe('klimmzug');
  });

  it('folds accents on a real-world example (Kniebeuge unaffected, but é/ü/ñ fold)', () => {
    expect(normalizeExerciseName('Café')).toBe('cafe');
    expect(normalizeExerciseName('Piñata Press')).toBe('pinata press');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeExerciseName('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// findCatalogMatch
// ---------------------------------------------------------------------------

describe('findCatalogMatch', () => {
  it('matches on nameEn (case/whitespace-insensitive)', () => {
    const match = findCatalogMatch('  pull-up  ', mockCatalog);
    expect(match?.id).toBe(CATALOG_EXERCISE_ID_PULLUP);
  });

  it('matches a German proposed name against an English-cataloged exercise via its translation', () => {
    // mockCatalog Pull-Up carries translations: [{ languageCode: 'de', name: 'Klimmzug' }]
    const match = findCatalogMatch('Klimmzug', mockCatalog);
    expect(match?.id).toBe(CATALOG_EXERCISE_ID_PULLUP);
  });

  it('matches a German proposed name with surrounding whitespace and mixed case', () => {
    const match = findCatalogMatch('  KLIMMZUG  ', mockCatalog);
    expect(match?.id).toBe(CATALOG_EXERCISE_ID_PULLUP);
  });

  it('returns undefined for a name with no catalog match', () => {
    expect(findCatalogMatch('Nonexistent Exercise Name', mockCatalog)).toBeUndefined();
  });

  it('returns undefined for an empty proposed name', () => {
    expect(findCatalogMatch('', mockCatalog)).toBeUndefined();
  });

  it('returns undefined for a whitespace-only proposed name', () => {
    expect(findCatalogMatch('   ', mockCatalog)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCatalogMatch — origin scoping (141-18, G-141-2-SCOPE)
// ---------------------------------------------------------------------------

describe('findCatalogMatch origin scoping', () => {
  const catalogWithCustomExercise = [
    ...mockCatalog,
    {
      id: 'user-ex-custom-1',
      key: 'user_exercise:user-ex-custom-1',
      nameEn: 'Ring Rows',
      mode: 'REPS',
      usesWeight: false,
      lastModifiedAt: 1_700_000_000_000,
      translations: [],
      muscleGroups: [],
      equipment: [],
      capabilities: [],
      origin: 'CUSTOM' as const,
    },
  ];

  it('still finds a curated (origin: CATALOG) entry by name', () => {
    const match = findCatalogMatch('Pull-Up', catalogWithCustomExercise);
    expect(match?.id).toBe(CATALOG_EXERCISE_ID_PULLUP);
  });

  it('does NOT find a user-created (origin: CUSTOM) exercise, even on an exact name match', () => {
    const match = findCatalogMatch('Ring Rows', catalogWithCustomExercise);
    expect(match).toBeUndefined();
  });
});
