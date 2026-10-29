/**
 * Structure test of Rule P (Phase 166, plan 166-04; D-03, protocol §1.11 "Rule P: one
 * population for every count"): every function that computes a count of §1.11 reads the shared
 * population of `src/training-state/set-population.ts` and builds no resolution of its own.
 *
 * The list below is the one source of the counting functions. Plan 166-06 adds the readers of
 * `get_stats`, the capability balance and the suspect marks. For every listed function the test
 * reads its source from `src/` and requires
 *   - a call of `resolveSetPopulation(`, and
 *   - no own exercise resolution over the workout exercises (`new Map(` over `templateExercises`),
 *     which is how every count resolved sets before 166.
 * A listed function the test cannot find fails with `NICHT GEMESSEN: <name>` — a gate that
 * measured nothing must never read as green. A planted source with its own resolution must be
 * caught (control case).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = join(__dirname, '..', '..');

/** The functions that compute a count of protocol §1.11, with the source file they live in. */
export const POPULATION_COUNT_FUNCTIONS: readonly { name: string; file: string }[] = [
  { name: 'computeMuscleBalance', file: 'src/training-state/muscle-balance.ts' },
  { name: 'computePersonalRecords', file: 'src/training-state/consistency.ts' },
  // Plan 166-06: the three branches of get_stats (Rule P, D-03).
  { name: 'getStatsByExercise', file: 'src/tools/get_stats.ts' },
  { name: 'getStatsByMuscle', file: 'src/tools/get_stats.ts' },
  { name: 'getStatsByCapabilities', file: 'src/tools/get_stats.ts' },
];

/**
 * The source text of the top-level function `name`, from its `function name(` up to the first
 * closing brace in column 0 after it (every top-level function of `src/` ends that way), or
 * `null` when the source has no such function.
 */
function functionSource(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  if (start < 0) return null;
  const end = source.indexOf('\n}\n', start);
  return end < 0 ? null : source.slice(start, end + 2);
}

const OWN_TEMPLATE_EXERCISE_MAP = /new Map\([^;]*templateExercises/;

export function scanPopulationGate(
  sources: Record<string, string>,
  list: readonly { name: string; file: string }[],
): { measured: string[]; problems: string[] } {
  const measured: string[] = [];
  const problems: string[] = [];
  for (const { name, file } of list) {
    const source = sources[file];
    const body = source === undefined ? null : functionSource(source, name);
    if (body === null) {
      problems.push(`NICHT GEMESSEN: ${name}`);
      continue;
    }
    measured.push(name);
    if (!body.includes('resolveSetPopulation(')) problems.push(`${file}:${name} does not read resolveSetPopulation`);
    if (OWN_TEMPLATE_EXERCISE_MAP.test(body)) problems.push(`${file}:${name} builds its own map over templateExercises`);
  }
  return { measured, problems };
}

describe('population gate (Rule P, D-03)', () => {
  it('P166 counts of section 1.11 read only the shared population', () => {
    const sources: Record<string, string> = {};
    for (const { file } of POPULATION_COUNT_FUNCTIONS) sources[file] = readFileSync(join(MCP_ROOT, file), 'utf8');
    const { measured, problems } = scanPopulationGate(sources, POPULATION_COUNT_FUNCTIONS);
    expect(problems).toEqual([]);
    expect(measured, 'NICHT GEMESSEN: fewer functions measured than listed').toEqual(POPULATION_COUNT_FUNCTIONS.map((f) => f.name));
    expect(measured.length).toBeGreaterThanOrEqual(2);
  });

  it('P166 the population gate catches a planted own template exercise map', () => {
    const list = [
      { name: 'plantedOwnResolution', file: 'planted.ts' },
      { name: 'plantedShared', file: 'planted.ts' },
      { name: 'plantedMissing', file: 'planted.ts' },
    ];
    const planted = {
      'planted.ts': [
        'export function plantedOwnResolution(snapshot: S): number {',
        '  const templateExerciseById = new Map(snapshot.templateExercises.map((te) => [te.id, te]));',
        '  return templateExerciseById.size;',
        '}',
        '',
        'export function plantedShared(snapshot: S, catalogById: C): number {',
        '  return resolveSetPopulation(snapshot, catalogById, { requireFinishedSession: true }).length;',
        '}',
        '',
      ].join('\n'),
    };
    const { measured, problems } = scanPopulationGate(planted, list);
    expect(measured).toEqual(['plantedOwnResolution', 'plantedShared']);
    expect(problems).toEqual([
      'planted.ts:plantedOwnResolution does not read resolveSetPopulation',
      'planted.ts:plantedOwnResolution builds its own map over templateExercises',
      'NICHT GEMESSEN: plantedMissing',
    ]);
  });
});
