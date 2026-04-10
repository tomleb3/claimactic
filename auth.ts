// ─────────────────────────────────────────────────────────────────────────────
// auth.ts — One-time local login to obtain a Steam refresh token.
//
// Run once:  npm run auth
//
// Logs in with username/password (prompted interactively), handles Steam Guard,
// then pushes the refresh token and optional config to GitHub via `gh`.
// ─────────────────────────────────────────────────────────────────────────────
import SteamUser from 'steam-user';
import { execSync } from 'child_process';
import readline from 'readline';

function promptForInput(message: string, hidden = false): Promise<string> {
    return new Promise<string>((resolve) => {
        if (hidden) {
            process.stdout.write(message);
            const rl = readline.createInterface({ input: process.stdin, terminal: false });
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            let input = '';
            const onData = (ch: Buffer): void => {
                const c = ch.toString();
                if (c === '\n' || c === '\r') {
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    process.stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    rl.close();
                    resolve(input.trim());
                } else if (c === '\u007F' || c === '\b') {
                    input = input.slice(0, -1);
                } else if (c === '\u0003') {
                    process.exit(1);
                } else {
                    input += c;
                }
            };
            process.stdin.on('data', onData);
            process.stdin.resume();
        } else {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(message, (answer: string) => {
                rl.close();
                resolve(answer.trim());
            });
        }
    });
}

function ghAvailable(): boolean {
    try {
        execSync('gh auth status', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function ghSetSecret(repo: string, name: string, value: string): void {
    execSync(`gh secret set ${name} -R ${repo}`, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    console.log(`  ✓ Secret ${name} set`);
}

function ghSetVariable(repo: string, name: string, value: string): void {
    execSync(`gh variable set ${name} -R ${repo}`, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    console.log(`  ✓ Variable ${name} set`);
}

async function main(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║            Steam Auto-Claimer — Setup                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const username = await promptForInput('Steam username: ');
    const password = await promptForInput('Steam password: ', true);

    if (!username || !password) {
        console.error('ERROR: Username and password are required.');
        process.exit(1);
    }

    console.log(`\nLogging in as "${username}"…\n`);

    const client = new SteamUser();

    client.on('steamGuard', async (domain: string | null, callback: (code: string) => void) => {
        const source = domain
            ? `your email at ${domain}`
            : 'the Steam mobile app';
        const code = await promptForInput(`Enter Steam Guard code from ${source}: `);
        callback(code);
    });

    client.on('refreshToken', async (token: string) => {
        console.log('\n  Refresh token obtained.\n');

        if (!ghAvailable()) {
            console.log('  GitHub CLI (`gh`) not found or not authenticated.');
            console.log('  Install it and run `gh auth login`, then re-run this script.\n');
            console.log('  In the meantime, here is your token to set manually:\n');
            console.log(token);
            client.logOff();
            process.exit(0);
        }

        console.log('  Pushing secrets and variables to GitHub…\n');

        const repo = await promptForInput('GitHub repo (owner/name): ');
        if (!repo) {
            console.error('ERROR: Repo is required to push secrets.');
            client.logOff();
            process.exit(1);
        }

        ghSetSecret(repo, 'STEAM_REFRESH_TOKEN', token);

        const minReviews = await promptForInput('Min reviews (default: 500): ');
        if (minReviews) ghSetVariable(repo, 'MIN_REVIEWS', minReviews);

        const minRating = await promptForInput('Min positive rating % (default: 70): ');
        if (minRating) ghSetVariable(repo, 'MIN_POSITIVE_PCT', minRating);

        console.log('\n  Done! The GitHub Actions workflow will use these values.');
        console.log('  Trigger it manually:  gh workflow run claim.yml\n');

        client.logOff();
        process.exit(0);
    });

    client.on('error', (err: Error & { eresult?: number }) => {
        console.error(`\nSteam error: ${err.message}`);
        if (err.eresult === SteamUser.EResult.InvalidPassword) {
            console.error('Check your username and password.');
        }
        process.exit(1);
    });

    client.logOn({
        accountName: username,
        password: password,
    });
}

main();
