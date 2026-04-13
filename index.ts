// ─────────────────────────────────────────────────────────────────────────────
// claimactic - Claims high-quality games that are temporarily 100% off
// ─────────────────────────────────────────────────────────────────────────────
import SteamUser from 'steam-user';
import https from 'https';
import { IncomingMessage } from 'http';

interface Config {
    readonly refreshToken: string | undefined;
    readonly minReviews: number;
    readonly minPositivePct: number;
}

interface GameCandidate {
    readonly appId: number;
}

interface AppDetails {
    readonly name: string;
    readonly type: string;
    readonly isFree: boolean;
    readonly discountPercent: number;
    readonly hasPriceInfo: boolean;
    readonly packages: readonly number[];
}

interface StoreClaimContext {
    readonly sessionId: string;
    readonly cookies: string[];
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
    readonly alreadyOwned?: boolean;
    readonly error?: string;
}

const USER_AGENT = 'claimactic/1.0';

const CONFIG: Config = {
    refreshToken: process.env.STEAM_REFRESH_TOKEN,
    minReviews: parseInt(process.env.MIN_REVIEWS ?? '', 10) || 500,
    minPositivePct: parseInt(process.env.MIN_POSITIVE_PCT ?? '', 10) || 70,
};

// ─── Utility: HTTPS GET returning parsed JSON ───────────────────────────────

function httpsGetJSON<T = unknown>(url: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
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

// ─── Data Source: Steam Store search for free specials ──────────────────────
// Uses the undocumented JSON search endpoint. category1=998 = Games only.
// specials=1 = currently on sale.  maxprice=free = price is $0 right now.

interface StoreSearchResponse {
    readonly results_html?: string;
}

async function fetchFromSteamStoreSearch(): Promise<readonly GameCandidate[]> {
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

// ─── Steam Store API: App details ───────────────────────────────────────────
// Returns price info and basic metadata for a single app.

interface AppDetailsAPIResponse {
    readonly [appId: string]: {
        readonly success: boolean;
        readonly data?: {
            readonly name: string;
            readonly type: string;
            readonly is_free: boolean;
            readonly packages?: readonly number[];
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
        hasPriceInfo: d.price_overview != null,
        packages: d.packages ?? [],
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

    if (reviews === null) {
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

// ─── Steam Store: claim a free/promo license via HTTP POST ─────────────────
// requestFreeLicense (CM protocol) only works for free-on-demand (F2P) games.
// Promotional 100%-off games require a store "purchase" via the web API.
// This POST mirrors what the Steam client does at checkout for $0 items.

function claimFreePackage(subId: number, ctx: StoreClaimContext): Promise<ClaimResult> {
    return new Promise<ClaimResult>((resolve) => {
        const postData = new URLSearchParams({
            action: 'add_to_cart',
            sessionid: ctx.sessionId,
            subid: String(subId),
        }).toString();

        const req = https.request(
            {
                hostname: 'store.steampowered.com',
                path: '/freelicense/addfreelicense',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': String(Buffer.byteLength(postData)),
                    Cookie: ctx.cookies.join('; '),
                    'User-Agent': USER_AGENT,
                },
            },
            (res: IncomingMessage) => {
                let body = '';
                res.on('data', (chunk: string) => (body += chunk));
                res.on('end', () => {
                    const errorMatch = body.match(/<span class="error">([^<]+)<\/span>/);
                    if (errorMatch) {
                        return resolve({ success: false, error: errorMatch[1].trim() });
                    }

                    if (body.includes('<h2>Success!</h2>')) {
                        return resolve({ success: true });
                    }

                    // A redirect or clean page without error often means already owned
                    if (res.statusCode! >= 300 && res.statusCode! < 400) {
                        return resolve({ success: true, alreadyOwned: true });
                    }

                    resolve({ success: false, error: `Unexpected response (HTTP ${res.statusCode})` });
                });
            },
        );

        req.on('error', (err: Error) => resolve({ success: false, error: err.message }));
        req.setTimeout(15_000, () => {
            req.destroy();
            resolve({ success: false, error: 'Request timeout' });
        });
        req.write(postData);
        req.end();
    });
}

// ─── Console helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Core loop ──────────────────────────────────────────────────────────────

async function checkAndClaim(client: SteamUser, storeCtx: StoreClaimContext): Promise<void> {
    console.log(`\n[${new Date().toISOString()}] Checking for free games…`);

    let candidates: readonly GameCandidate[];
    try {
        candidates = await fetchFromSteamStoreSearch();
    } catch (err) {
        console.error(`Error fetching free games: ${(err as Error).message}`);
        return;
    }

    if (candidates.length === 0) {
        console.log('No free games found.');
        return;
    }

    console.log(`Found ${candidates.length} candidate(s).`);

    let claimed = 0;
    let skipped = 0;

    for (const game of candidates) {
        const { appId } = game;
        await sleep(1500);

        try {
            const details = await getAppDetails(appId);
            if (!details) continue;

            if (client.ownsApp(appId)) {
                console.log(`  OWNED  ${details.name}`);
                continue;
            }

            const reviews = await getAppReviews(appId);
            const { pass, reason } = evaluateGame(details, reviews);

            if (!pass) {
                console.log(`  SKIP   ${details.name} - ${reason}`);
                skipped++;
                continue;
            }

            if (details.packages.length === 0) {
                console.log(`  SKIP   ${details.name} - no packages`);
                continue;
            }

            const subId = details.packages[0];
            const result = await claimFreePackage(subId, storeCtx);

            if (result.success && result.alreadyOwned) {
                console.log(`  OWNED  ${details.name}`);
            } else if (result.success) {
                console.log(`  CLAIM  ${details.name} (${reviews!.positivePercent}% positive)`);
                claimed++;
            } else {
                console.log(`  FAIL   ${details.name} - ${result.error}`);
            }
        } catch (err) {
            console.error(`  ERROR  App ${appId}: ${(err as Error).message}`);
        }
    }

    console.log(`Done: ${claimed} claimed, ${skipped} skipped.`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const refreshToken = CONFIG.refreshToken;

    if (!refreshToken) {
        console.error(
            'ERROR: Set STEAM_REFRESH_TOKEN.\n' +
            'Run "npm run auth" to obtain a refresh token.'
        );
        process.exit(1);
    }

    console.log(
        'claimactic | refresh token | single run' +
        ` | ${CONFIG.minReviews}+ reviews, ${CONFIG.minPositivePct}%+ rating`
    );

    const client = new SteamUser({ enablePicsCache: true });

    // ── Connected ───────────────────────────────────────────────────────────
    client.on('loggedOn', () => {
        console.log(`Logged in (${client.steamID})`);
    });

    // ── Web session - gives us cookies needed for Store API claims ────────
    let latestStoreCtx: StoreClaimContext | null = null;
    client.on('webSession', (sessionId: string, cookies: string[]) => {
        latestStoreCtx = { sessionId, cookies };
    });

    // ── Ownership cache ready - now safe to check ownsApp and claim ───────
    client.on('ownershipCached', async () => {
        if (!latestStoreCtx) {
            console.error('Web session not available.');
            return;
        }

        await checkAndClaim(client, latestStoreCtx);
        client.logOff();
        process.exit(0);
    });

    // ── Handle errors ───────────────────────────────────────────────────────
    client.on('error', (err: Error & { readonly eresult?: number }) => {
        console.error(`Steam error: ${err.message}`);
        process.exit(1);
    });

    client.on('disconnected', (_eresult: number, msg?: string) => {
        console.error(`Disconnected: ${msg ?? 'unknown reason'}`);
        process.exit(1);
    });

    // ── Log in ──────────────────────────────────────────────────────────────
    client.logOn({ refreshToken });
}

main();
