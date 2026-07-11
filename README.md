# claimactic

Automatically claims high-quality Steam games that are temporarily 100% off and runs through GitHub Actions.

## Use This Template

1. Click **Use this template** and create your own repo.
2. If you want your run history and cron runs private, make that repo **private**.

The source/template repo stays manual-only. Add scheduled runs only in the repo that should own the run history.

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

If you want automatic runs, uncomment the `schedule` block in `.github/workflows/claim.yml` in your repo and set your cron.

Example:

```yaml
schedule:
  - cron: '0 3 * * *'
```

If the repo running the workflow is public, its Actions history is public too.

## Optional: Keep Your Repo Updated

Repos created from a template are standalone, so GitHub's **Sync fork** button does not apply.

On the first sync from your actual template/source repo, Git will likely report unrelated histories. That is expected for repos created from a template.

First sync:

```bash
git remote add template https://github.com/tomleb3/claimactic.git
```

Later syncs:

```bash
git fetch template
git merge template/claimactic
git push origin HEAD
```

If the template/source repo changes `.github/workflows/claim.yml`, make sure the `schedule` block is still uncommented in your repo.

## Commands

```bash
npm ci
npm run auth
npm run start
npx tsc --noEmit
gh workflow run claim.yml -R owner/repo
```