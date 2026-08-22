# Activation benchmark artifacts

This directory is populated automatically by `src/test/activationProfile.test.ts` when
`npm run test` runs.

- `activation-baseline-latest.json` — machine-readable profile from the most recent run.
- `activation-baseline-latest.md` — human-readable phase breakdown from the most recent run.

Both files are gitignored because they change every run. The committed baseline lives in
`docs/activation-timing-profile.md`.
