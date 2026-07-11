# claimactic

Automatically claims high-quality Steam games that are temporarily 100% off and runs through GitHub Actions.

## Use This Template

1. Click **Use this template** and create your own repo.
2. If you want your run history and cron runs private, make that new repo **private**.

The public template stays manual-only. Add scheduled runs only in the repo that should own the run history.

## Setup

1. Clone your new repo.
2. Install dependencies:

```bash
npm ci
```

3. Run the interactive setup:

```bash
npm run auth
```

`npm run auth` logs into Steam, obtains your refresh token, and pushes the required GitHub Secret and optional GitHub Variables to the repo you choose.

## Schedule

If you want automatic runs, uncomment the `schedule` block in `.github/workflows/claim.yml` in your runtime repo and set your cron.

Example:

```yaml
schedule:
  - cron: '0 3 * * *'
```

If the repo running the workflow is public, its Actions history is public too.

## Commands

```bash
npm ci
npm run auth
npm run start
npx tsc --noEmit
gh workflow run claim.yml -R owner/repo
```