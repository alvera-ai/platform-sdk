/**
 * accounts_receivable/smoke — minimal placeholder spec.
 *
 * The accounts_receivable industry has no integration coverage yet — only
 * healthcare specs were brought across in the initial migration. This
 * spec exists to keep `pnpm test:accounts_receivable` (and the chained
 * `pnpm test`) green until real specs land. It performs no API calls,
 * loads no state, and asserts only that the env is wired correctly.
 *
 * Replace with real specs (and expand `_order.json`) when the AR
 * industry is productionised.
 */
import { describe, expect, it } from 'vitest'
import { config } from '../../src/env'

describe('accounts_receivable/smoke', () => {
  it('§1 env baseUrl is configured', () => {
    expect(config.baseUrl).toMatch(/^https?:\/\//)
  })
})
