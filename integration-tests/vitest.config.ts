import { defineConfig } from 'vitest/config'
import { ManifestSequencer } from './vitest.sequencer'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Single-process, single-fork — every spec file runs sequentially in
    // one Node process. Required because state files threaded between
    // specs (`<runId>/<spec>.state.json`) are read in beforeAll, so a
    // spec must fully finish writing before the next spec's beforeAll
    // runs. fileParallelism: false alone isn't enough on the threads
    // pool — vitest still loads multiple files concurrently. Forcing
    // singleFork eliminates that race.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Deterministic alphabetical file order, no shuffling.
    sequence: {
      shuffle: false,
      concurrent: false,
      sequencer: ManifestSequencer,
    },

    reporters: ['verbose'],
  },
})
