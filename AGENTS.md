# claimactic

## Code Style

- TypeScript, strict mode (TS 6 defaults)
- No em dashes. Use hyphens (-) or reword instead.
- Keep console output minimal: one line per game, no banners or box art
- No emojis in code or output

## Architecture

- `index.ts`: Main claimer (discovery, evaluation, claiming)
- `auth.ts`: One-time interactive setup (login, refresh token, GitHub secrets)
- Only runtime dependency: `steam-user`. All HTTP via native `https` module.
- Ownership checks via PICS cache (`client.ownsApp()`), not file-based tracking.
- Promotional game claiming via HTTPS POST to Steam Store, not `requestFreeLicense`.
- Scheduling is handled by the GitHub Actions workflow, not by `index.ts`.

## Build and Test

- `npm run start` - Run the claimer
- `npm run auth` - Interactive setup
- `npx tsc --noEmit` - Type-check

## Conventions

- Avoid adding npm packages unless clearly necessary and well-maintained (high stars/downloads)
- Environment variables for all config; no dotenv, no config files
- GitHub secrets managed via `gh` CLI in auth.ts
- Single-file-per-concern: don't split into many small modules
