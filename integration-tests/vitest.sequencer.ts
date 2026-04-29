import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

/**
 * ManifestSequencer — orders test files by an explicit per-directory
 * manifest, so the spec dependency graph is data-driven instead of
 * baked into filenames.
 *
 * For each test file, the sequencer:
 *   1. Reads `<spec-dir>/_order.json` (an array of spec slugs).
 *   2. Derives the spec's slug = basename without `.test.ts`.
 *   3. Sorts by slug position in the manifest.
 *
 * Specs absent from the manifest are an error — typos in spec names
 * fail loudly instead of silently moving the spec to the end of the
 * run. Specs in DIFFERENT directories use DIFFERENT manifests, so each
 * industry (`tests/healthcare`, `tests/accounts_receivable`,
 * `tests/payment_risk`) owns its own dependency chain.
 *
 * Manifest reads are cached per-directory — one read per industry
 * regardless of how many specs vitest schedules.
 *
 * Vitest 4 note: the spec arg is `TestSpecification` (a class with a
 * `.moduleId` property), not the v2 tuple `[project, filePath]`. Access
 * `.moduleId` directly — destructuring it as iterable raises
 * `object is not iterable`.
 */
export class ManifestSequencer extends BaseSequencer {
  private manifestCache = new Map<string, string[]>()

  private manifestFor(specDir: string): string[] {
    const cached = this.manifestCache.get(specDir)
    if (cached) return cached

    const manifestPath = resolve(specDir, '_order.json')
    if (!existsSync(manifestPath)) {
      throw new Error(
        `ManifestSequencer: missing ${manifestPath}.\n` +
          `Every test directory must declare its run order in _order.json — ` +
          `an array of spec slugs (filename minus '.test.ts').`,
      )
    }

    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      throw new Error(`ManifestSequencer: ${manifestPath} must be an array of strings.`)
    }

    this.manifestCache.set(specDir, parsed)
    return parsed
  }

  private slugOf(filePath: string): string {
    return basename(filePath, '.test.ts')
  }

  private orderIndex(spec: TestSpecification): number {
    const filePath = spec.moduleId
    const dir = dirname(filePath)
    const slug = this.slugOf(filePath)
    const manifest = this.manifestFor(dir)
    const idx = manifest.indexOf(slug)
    if (idx === -1) {
      throw new Error(
        `ManifestSequencer: spec "${slug}" not declared in ${dir}/_order.json.\n` +
          `Add it to the array (in the right dependency position) before running.`,
      )
    }
    return idx
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => this.orderIndex(a) - this.orderIndex(b))
  }
}
