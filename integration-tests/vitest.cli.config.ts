import { defineConfig } from 'vitest/config'
import { ManifestSequencer } from './vitest.sequencer'

export default defineConfig({
  test: {
    include: ['tests/cli/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    pool: 'forks',
    forks: {
      singleFork: true,
    },
    sequence: {
      shuffle: false,
      concurrent: false,
      sequencer: ManifestSequencer,
    },
    reporters: ['verbose'],
  },
})
