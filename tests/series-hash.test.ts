/**
 * Tests for src/series-hash.ts — the MCP-side seriesHash canonicalization (protocol
 * §4). Corpus-driven over `docs/coach-planning-vectors.json`'s `seriesHash` section
 * (2 vectors, shared with `SeriesHash.kt`'s Kotlin twin via `SeriesHashTest.kt`) plus
 * hand-written encoding-rule and field-allowlist assertions the corpus vectors don't
 * individually isolate.
 */

import { describe, it, expect } from 'vitest';
import { canonicalSeriesString, computeSeriesHash, type SeriesHashRoot } from '../src/series-hash.js';
import { loadCoachPlanningVectors } from './shared-vectors.js';

describe('computeSeriesHash / canonicalSeriesString — shared corpus (seriesHash)', () => {
  const corpus = loadCoachPlanningVectors();

  it('the seriesHash section is not empty', () => {
    expect(corpus.seriesHash.length).toBeGreaterThan(0);
  });

  it('every corpus vector reproduces its own canonical string byte-for-byte and its own 64-hex digest', () => {
    for (const vector of corpus.seriesHash) {
      const canonical = canonicalSeriesString(vector.roots);
      expect(canonical, `vector '${vector.name}' canonical string mismatch`).toBe(vector.expectedCanonicalString);
      const hash = computeSeriesHash(vector.roots);
      expect(hash, `vector '${vector.name}' digest mismatch`).toBe(vector.expectedHash);
    }
  });

  it('reproduces the pinned digest fe814f4c258b2960c67d88822670ac5e67e64e64f47c5be8da29989d271cb6ed for single-root-unsorted-duplicate-deleted-occurrences', () => {
    const vector = corpus.seriesHash.find((v) => v.name === 'single-root-unsorted-duplicate-deleted-occurrences');
    expect(vector).toBeDefined();
    expect(computeSeriesHash(vector!.roots)).toBe('fe814f4c258b2960c67d88822670ac5e67e64e64f47c5be8da29989d271cb6ed');
  });
});

describe('SeriesHashRoot — exactly the seven protocol §4 fields, no note field', () => {
  it('a root object literal satisfying SeriesHashRoot carries exactly seven keys', () => {
    const root: SeriesHashRoot = {
      id: '11111111-1111-4111-8111-111111111111',
      templateId: '22222222-2222-4222-8222-222222222222',
      scheduledDate: 1_780_000_000_000,
      scheduledTime: null,
      recurrenceRule: null,
      recurrenceGroupId: null,
      deletedOccurrencesRaw: null,
    };
    expect(Object.keys(root).sort()).toStrictEqual(
      [
        'deletedOccurrencesRaw',
        'id',
        'recurrenceGroupId',
        'recurrenceRule',
        'scheduledDate',
        'scheduledTime',
        'templateId',
      ].sort(),
    );
  });
});

describe('encoding rules (protocol §4)', () => {
  const baseRoot: SeriesHashRoot = {
    id: '11111111-1111-4111-8111-111111111111',
    templateId: '22222222-2222-4222-8222-222222222222',
    scheduledDate: 1_780_000_000_000,
    scheduledTime: null,
    recurrenceRule: null,
    recurrenceGroupId: null,
    deletedOccurrencesRaw: null,
  };

  it('an absent deletedOccurrencesRaw serializes as an empty JSON array, never null and never the string "null"', () => {
    const canonical = canonicalSeriesString([baseRoot]);
    expect(canonical).toContain('"deletedOccurrences":[]');
    expect(canonical).not.toContain('"deletedOccurrences":null');
  });

  it('an absent scheduledTime serializes as JSON null', () => {
    const canonical = canonicalSeriesString([baseRoot]);
    expect(canonical).toContain('"scheduledTime":null');
  });

  it('roots sort by PLAIN STRING id order, not UUID natural (signed) order', () => {
    // Chosen so the two orders diverge: id2's most-significant byte (0x80) has its sign
    // bit set, so a signed-long UUID.compareTo would rank id2 BEFORE id1 — but plain
    // string comparison ('0' < '8') ranks id1 first. If this test ever passes with id2
    // first, canonicalSeriesString silently regressed to a signed/natural comparator.
    const id1 = '00000000-0000-4000-8000-000000000001';
    const id2 = '80000000-0000-4000-8000-000000000002';
    const roots: SeriesHashRoot[] = [
      { ...baseRoot, id: id2 },
      { ...baseRoot, id: id1 },
    ];
    const canonical = canonicalSeriesString(roots);
    expect(canonical.indexOf(id1)).toBeLessThan(canonical.indexOf(id2));
  });

  it('deletedOccurrencesRaw is deduplicated and sorted ascending regardless of stored order', () => {
    const root: SeriesHashRoot = {
      ...baseRoot,
      deletedOccurrencesRaw: '["2026-06-09","2026-06-02","2026-06-09"]',
    };
    const canonical = canonicalSeriesString([root]);
    expect(canonical).toContain('"deletedOccurrences":["2026-06-02","2026-06-09"]');
  });

  it('computeSeriesHash returns 64 lowercase hex characters', () => {
    const hash = computeSeriesHash([baseRoot]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
