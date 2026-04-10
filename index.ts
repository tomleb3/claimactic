// ─────────────────────────────────────────────────────────────────────────────
// Steam Auto-Claimer — Claims high-quality games that are temporarily 100% off
// ─────────────────────────────────────────────────────────────────────────────
import SteamUser from 'steam-user';
import RSSParser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import https from 'https';
import { IncomingMessage } from 'http';

interface Config {
    readonly refreshToken: string | undefined;
    readonly username: string | undefined;
    readonly password: string | undefined;
    readonly minReviews: number;
    readonly minPositivePct: number;
    readonly pollIntervalMs: number;
    readonly singleRun: boolean;
}

interface GameCandidate {
    readonly appId: number;
    readonly name?: string;
}

interface AppDetails {
    readonly name: string;
    readonly type: string;
    readonly isFree: boolean;
    readonly discountPercent: number;
    readonly finalPrice: number | null;
    readonly hasPriceInfo: boolean;
}

interface AppReviews {
    readonly totalPositive: number;
    readonly totalNegative: number;
    readonly totalReviews: number;
    readonly positivePercent: number;
}

interface EvaluationResult {
    readonly pass: boolean;
    readonly reason: string;
}

interface ClaimResult {
    readonly success: boolean;
    readonly error?: string;
    readonly grantedPackages?: readonly number[];
    readonly grantedApps?: readonly number[];
}

interface ClaimedEntry {
    readonly name: string;
    readonly action: 'claimed' | 'skipped' | 'failed';
    readonly reason?: string;
    readonly error?: string;
    readonly date: string;
}

interface ClaimedMap {
    [appId: string]: ClaimedEntry;
}

const CONFIG: Config = {
    refreshToken: process.env.STEAM_REFRESH_TOKEN,
    username: process.env.STEAM_USERNAME,
    password: process.env.STEAM_PASSWORD,
    minReviews: parseInt(process.env.MIN_REVIEWS ?? '', 10) || 500,
    minPositivePct: parseInt(process.env.MIN_POSITIVE_PCT ?? '', 10) || 70,
    pollIntervalMs: (parseInt(process.env.POLL_INTERVAL_MINUTES ?? '', 10) || 60) * 60 * 1000,
    singleRun: process.env.SINGLE_RUN === 'true' || process.env.CI === 'true',
};

const CLAIMED_PATH: string = path.join(__dirname, 'claimed.json');

// ─── Utility: HTTPS GET returning parsed JSON ───────────────────────────────

function httpsGetJSON<T = unknown>(url: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': 'SteamAutoClaimerMVP/1.0' },
        }, (res: IncomingMessage) => {
            if (res.statusCode! >= 300 && res.statusCode! < 400 && res.headers.location) {
                // Follow one redirect
                return httpsGetJSON<T>(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode! < 200 || res.statusCode! >= 300) {
                res.resume(); // drain the response
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let body = '';
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body) as T);
                } catch {
                    reject(new Error(`Invalid JSON from ${url}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15_000, () => {
            req.destroy();
            reject(new Error(`Request timeout: ${url}`));
        });
    });
}

// ─── Claimed-list persistence ───────────────────────────────────────────────

function loadClaimed(): ClaimedMap {
    try {
        return JSON.parse(fs.readFileSync(CLAIMED_PATH, 'utf8')) as ClaimedMap;
    } catch {
        return {};
    }
}

function saveClaimed(claimed: ClaimedMap): void {
    fs.writeFileSync(CLAIMED_PATH, JSON.stringify(claimed, null, 2));
}

// ─── Data Source 1: SteamDB "Free Promotions" RSS ───────────────────────────
// SteamDB publishes an RSS feed of games with 100 % discounts.
// This may return a 403 if SteamDB blocks automated requests — that's fine,
// we fall back to the Steam Store search below.

async function fetchFromSteamDBRSS(): Promise<GameCandidate[]> {
    const parser = new RSSParser({
        headers: { 'User-Agent': 'SteamAutoClaimerMVP/1.0' },
        timeout: 15_000,
    });
    const feed = await parser.parseURL('https://steamdb.info/sales/rss/');
    const results: GameCandidate[] = [];

    for (const item of feed.items) {
        const match = item.link?.match(/\/app\/(\d+)/);
        if (match) {
            results.push({
                appId: parseInt(match[1], 10),
                name: item.title || `App ${match[1]}`,
            });
        }
    }
    return results;
}

// ─── Data Source 2: Steam Store search for free specials ────────────────────
// Uses the undocumented JSON search endpoint. category1=998 = Games only.
// specials=1 = currently on sale.  maxprice=free = price is $0 right now.

interface StoreSearchResponse {
    readonly results_html?: string;
}

async function fetchFromSteamStoreSearch(): Promise<GameCandidate[]> {
    const url =
        'https://store.steampowered.com/search/results/' +
        '?query=&specials=1&maxprice=free&category1=998' +
        '&infinite=1&json=1&cc=us';

    const data = await httpsGetJSON<StoreSearchResponse>(url);
    const results: GameCandidate[] = [];

    if (data?.results_html) {
        const regex = /data-ds-appid="(\d+)"/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(data.results_html)) !== null) {
            results.push({ appId: parseInt(m[1], 10) });
        }
    }
    return results;
}

// ─── Combine both sources, deduplicate ──────────────────────────────────────

async function findFreeGames(): Promise<GameCandidate[]> {
    const games: GameCandidate[] = [];

    // Source 1: SteamDB RSS
    try {
        const rssGames = await fetchFromSteamDBRSS();
        log('RSS', `Found ${rssGames.length} item(s) from SteamDB feed.`);
        games.push(...rssGames);
    } catch (err) {
        log('RSS', `SteamDB feed unavailable (${(err as Error).message}). Using Steam Store only.`);
    }

    // Source 2: Steam Store search
    try {
        const storeGames = await fetchFromSteamStoreSearch();
        log('STORE', `Found ${storeGames.length} item(s) from Steam Store search.`);
        games.push(...storeGames);
    } catch (err) {
        log('STORE', `Steam Store search failed: ${(err as Error).message}`);
    }

    // Deduplicate by appId
    const seen = new Set<number>();
    return games.filter((g) => {
        if (seen.has(g.appId)) return false;
        seen.add(g.appId);
        return true;
    });
}

// ─── Steam Store API: App details ───────────────────────────────────────────
// Returns price info and basic metadata for a single app.

interface AppDetailsAPIResponse {
    readonly [appId: string]: {
        readonly success: boolean;
        readonly data?: {
            readonly name: string;
            readonly type: string;
            readonly is_free: boolean;
            readonly price_overview?: {
                readonly discount_percent: number;
                readonly final: number;
            };
        };
    };
}

async function getAppDetails(appId: number): Promise<AppDetails | null> {
    const url = `https://store.steampowered.com/api/appdetails/?appids=${encodeURIComponent(appId)}&cc=us`;
    const data = await httpsGetJSON<AppDetailsAPIResponse>(url);
    const entry = data?.[String(appId)];

    if (!entry?.success || !entry.data) return null;
    const d = entry.data;

    return {
        name: d.name,
        type: d.type,
        isFree: d.is_free === true,
        discountPercent: d.price_overview?.discount_percent ?? 0,
        finalPrice: d.price_overview?.final ?? null,
        hasPriceInfo: d.price_overview != null,
    };
}

// ─── Steam Reviews API ──────────────────────────────────────────────────────
// Returns aggregated review statistics for an app.

interface ReviewsAPIResponse {
    readonly query_summary?: {
        readonly total_positive: number;
        readonly total_negative: number;
    };
}

async function getAppReviews(appId: number): Promise<AppReviews | null> {
    const url =
        `https://store.steampowered.com/appreviews/${encodeURIComponent(appId)}` +
        '?json=1&language=all&purchase_type=all&num_per_page=0';
    const data = await httpsGetJSON<ReviewsAPIResponse>(url);

    if (!data?.query_summary) return null;
    const s = data.query_summary;
    const total = (s.total_positive || 0) + (s.total_negative || 0);

    return {
        totalPositive: s.total_positive || 0,
        totalNegative: s.total_negative || 0,
        totalReviews: total,
        positivePercent: total > 0 ? Math.round((s.total_positive / total) * 100) : 0,
    };
}

// ─── Quality evaluation ─────────────────────────────────────────────────────
// Decides whether a game is worth claiming based on:
//   1. It must be a "game" (not DLC, demo, video, etc.)
//   2. It must NOT be permanently Free-to-Play
//   3. It must have a 100 % discount applied to a real price
//   4. It must have enough reviews
//   5. Its positive-review percentage must meet the threshold

function evaluateGame(details: AppDetails, reviews: AppReviews | null): EvaluationResult {
    if (details.type !== 'game') {
        return { pass: false, reason: `Not a game (type: ${details.type})` };
    }

    // Permanently F2P titles have is_free=true and no price_overview.
    // A promo free game has is_free=false, price_overview with discount_percent=100.
    if (details.isFree && !details.hasPriceInfo) {
        return { pass: false, reason: 'Permanently Free to Play (no base price)' };
    }

    if (details.discountPercent !== 100) {
        return { pass: false, reason: `Not 100% off (discount: ${details.discountPercent}%)` };
    }

    if (!reviews) {
        return { pass: false, reason: 'No review data available' };
    }

    if (reviews.totalReviews < CONFIG.minReviews) {
        return {
            pass: false,
            reason: `Too few reviews (${reviews.totalReviews} < ${CONFIG.minReviews})`,
        };
    }

    if (reviews.positivePercent < CONFIG.minPositivePct) {
        return {
            pass: false,
            reason: `Rating too low (${reviews.positivePercent}% < ${CONFIG.minPositivePct}%)`,
        };
    }

    return {
        pass: true,
        reason: `${reviews.positivePercent}% positive from ${reviews.totalReviews} reviews`,
    };
}

// ─── Steam client: request a free license ───────────────────────────────────

function requestFreeLicense(client: SteamUser, appId: number): Promise<ClaimResult> {
    return new Promise<ClaimResult>((resolve) => {
        client.requestFreeLicense([appId], (err: Error | null, grantedPackages: number[], grantedApps: number[]) => {
            if (err) {
                return resolve({ success: false, error: err.message });
            }
            if (grantedApps.length === 0 && grantedPackages.length === 0) {
                return resolve({ success: false, error: 'Already owned or no license available' });
            }
            resolve({ success: true, grantedPackages, grantedApps });
        });
    });
}

// ─── Console helpers ────────────────────────────────────────────────────────

function promptForInput(message: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve) => {
        rl.question(message, (answer: string) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function log(tag: string, msg: string): void {
    console.log(`  [${tag}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Core loop ──────────────────────────────────────────────────────────────

async function checkAndClaim(client: SteamUser): Promise<void> {
    console.log(
        `\n${'─'.repeat(60)}\n` +
        `  ${new Date().toISOString()} — Checking for free games…\n` +
        `${'─'.repeat(60)}`
    );

    const claimed: ClaimedMap = loadClaimed();

    let candidates: GameCandidate[];
    try {
        candidates = await findFreeGames();
    } catch (err) {
        console.error('  Failed to fetch free games:', (err as Error).message);
        return;
    }

    if (candidates.length === 0) {
        console.log('  No free games found this cycle.');
        return;
    }

    console.log(`  ${candidates.length} candidate(s) found. Evaluating…\n`);

    for (const game of candidates) {
        const { appId } = game;

        // Skip games we already processed (claimed or skipped)
        if (claimed[appId]) continue;

        // Respectful delay between Steam API calls (avoid rate-limiting)
        await sleep(1500);

        try {
            // 1. Fetch metadata
            const details = await getAppDetails(appId);
            if (!details) {
                log('?', `App ${appId}: Could not fetch details — skipping.`);
                continue;
            }

            // 2. Fetch reviews
            const reviews = await getAppReviews(appId);

            // 3. Evaluate against quality filter
            const { pass, reason } = evaluateGame(details, reviews);

            if (!pass) {
                log('SKIP', `${details.name} (${appId}): ${reason}`);
                claimed[appId] = {
                    name: details.name,
                    action: 'skipped',
                    reason,
                    date: new Date().toISOString(),
                };
                saveClaimed(claimed);
                continue;
            }

            // 4. Claim!
            log('CLAIM', `${details.name} (${appId}) — ${reason}`);
            const result = await requestFreeLicense(client, appId);

            if (result.success) {
                console.log(`    ✓ Claimed "${details.name}" (Rating: ${reviews!.positivePercent}%)`);
                claimed[appId] = {
                    name: details.name,
                    action: 'claimed',
                    reason,
                    date: new Date().toISOString(),
                };
            } else {
                console.log(`    ✗ Could not claim "${details.name}": ${result.error}`);
                claimed[appId] = {
                    name: details.name,
                    action: 'failed',
                    error: result.error,
                    date: new Date().toISOString(),
                };
            }
            saveClaimed(claimed);
        } catch (err) {
            console.error(`  [ERR] App ${appId}: ${(err as Error).message}`);
        }
    }

    console.log(`\n  Cycle complete. Next check in ${CONFIG.pollIntervalMs / 60_000} minutes.`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const hasToken = !!CONFIG.refreshToken;
    const hasCredentials = !!CONFIG.username && !!CONFIG.password;

    if (!hasToken && !hasCredentials) {
        console.error(
            'ERROR: Set STEAM_REFRESH_TOKEN, or both STEAM_USERNAME and STEAM_PASSWORD.\n' +
            'Run "npm run auth" to obtain a refresh token.'
        );
        process.exit(1);
    }

    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║          Steam Auto-Claimer (Quality Filter)           ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  Auth:        ${hasToken ? 'refresh token' : 'username/password'}`);
    console.log(`  Mode:        ${CONFIG.singleRun ? 'single run' : `poll every ${CONFIG.pollIntervalMs / 60_000} min`}`);
    console.log(`  Min reviews: ${CONFIG.minReviews}`);
    console.log(`  Min rating:  ${CONFIG.minPositivePct}%\n`);

    const client = new SteamUser();

    // ── Handle Steam Guard 2FA (only relevant for username/password login) ──
    if (!hasToken) {
        client.on('steamGuard', async (domain: string | null, callback: (code: string) => void) => {
            const source = domain
                ? `your email at ${domain}`
                : 'your Steam Mobile Authenticator';
            const code = await promptForInput(`\n  Enter Steam Guard code from ${source}: `);
            callback(code);
        });
    }

    // ── Connected ───────────────────────────────────────────────────────────
    client.on('loggedOn', async () => {
        console.log(`  Logged in successfully (SteamID: ${client.steamID}).\n`);

        if (CONFIG.singleRun) {
            // CI mode: run once and exit
            await checkAndClaim(client);
            client.logOff();
            process.exit(0);
        } else {
            // Local mode: run now, then poll on interval
            checkAndClaim(client);
            setInterval(() => checkAndClaim(client), CONFIG.pollIntervalMs);
        }
    });

    // ── Handle errors ───────────────────────────────────────────────────────
    client.on('error', (err: Error & { eresult?: number }) => {
        console.error(`\n  Steam client error: ${err.message}`);
        if (err.eresult === SteamUser.EResult.InvalidPassword) {
            console.error('  → Check your credentials or refresh token.');
        }
        if (err.eresult === SteamUser.EResult.RateLimitExceeded) {
            console.error('  → Rate limited by Steam. Try again later.');
        }
        process.exit(1);
    });

    client.on('disconnected', (_eresult: number, msg?: string) => {
        console.warn(`\n  Disconnected from Steam (${msg ?? 'unknown reason'}). Exiting.`);
        process.exit(1);
    });

    // ── Log in ──────────────────────────────────────────────────────────────
    console.log('  Connecting to Steam…');
    if (hasToken) {
        client.logOn({ refreshToken: CONFIG.refreshToken! });
    } else {
        client.logOn({ accountName: CONFIG.username!, password: CONFIG.password! });
    }
}

main();
