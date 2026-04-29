/**
 * payment_risk/smoke — minimal placeholder spec.
 *
 * The payment_risk industry has no integration coverage yet — only
 * healthcare specs were brought across in the initial migration. This
 * spec exists to keep `pnpm test:payment_risk` (and the chained
 * `pnpm test`) green until real specs land. It performs no API calls,
 * loads no state, and asserts only that the env is wired correctly.
 *
 * Replace with real specs (and expand `_order.json`) when the PR
 * industry is productionised.
 */
import { describe, expect, it } from 'vitest'
import { config } from '../../src/env'

describe('payment_risk/smoke', () => {
  it('§1 env baseUrl is configured', () => {
    expect(config.baseUrl).toMatch(/^https?:\/\//)
  })
})
