import { load } from 'cheerio';
import pMap from 'p-map';
import sanitizeHtml from 'sanitize-html';

import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';

// Query the seven daily revisions to retain the existing empty-day selection.
// Render each published day through the official API so templates and links
// preserve their source meaning. Cache article HTML separately from item dates.
function getCurrentEventsDatePath(date: Date): string {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const year = date.getUTCFullYear();
    const month = months[date.getUTCMonth()];
    const day = date.getUTCDate(); // Not zero-padded
    return `Portal:Current_events/${year}_${month}_${day}`;
}
// The day's items sit between a {{Current events|...|top=yes}} and a
// {{Current events|...|bottom=yes}} call. Neither call nests braces, so [^{}] is enough to bound them.
const TOP_TEMPLATE = /\{\{\s*Current events\s*\|[^{}]*\btop\s*=\s*yes[^{}]*\}\}/i;
const BOTTOM_TEMPLATE = /\{\{\s*Current events\s*\|[^{}]*\bbottom\s*=\s*yes[^{}]*\}\}/i;
// Pages created before 2026-08-01 pass the items as the template's `content=` argument, closed by a
// trailing }}. Days that far back are only reachable through dateRange, so this arm exists for backfill.
// The (?=(\s*=))\1 dance around the `=` keeps \s* from overlapping the following [\s\S]*, which would
// otherwise backtrack super-linearly; see regexp(no-super-linear-backtracking).
const LEGACY_CONTENT_TEMPLATE = /\{\{Current events\s*\|[\s\S]*?content(?=(\s*=))\1\s*((?:\S[\s\S]*)?)\}\}$/;
// Simple MediaWiki template parser for {{Current events}} template
function parseCurrentEventsTemplate(wikitext: string): string | null {
    if (!wikitext) {
        return null;
    }
    let content: string;
    const top = wikitext.match(TOP_TEMPLATE);
    if (top) {
        content = wikitext.slice(top.index! + top[0].length);
        const bottom = content.match(BOTTOM_TEMPLATE);
        if (bottom) {
            content = content.slice(0, bottom.index);
        }
    } else {
        const legacy = wikitext.match(LEGACY_CONTENT_TEMPLATE);
        if (!legacy) {
            return null;
        }
        content = legacy[2];
    }
    content = content.trim();
    // Strip comments to detect empty content
    content = stripComments(content);
    // Check if content is empty or only contains empty bullets (e.g., "*", "**", with whitespace)
    if (/^\s*\*+\s*$/.test(content)) {
        return null;
    }
    return content;
}
function stripComments(html: string): string {
    return sanitizeHtml(html);
}
async function getRenderedWikiContent(pageName: string, revid: number): Promise<string> {
    const { data } = await got('https://en.wikipedia.org/w/api.php', {
        searchParams: {
            action: 'parse',
            format: 'json',
            oldid: revid,
            prop: 'text',
            disableeditsection: true,
            disabletoc: true,
        },
        headers: {
            'User-Agent': config.trueUA,
        },
    });
    if (typeof data.parse?.text?.['*'] !== 'string' || data.parse.title?.replaceAll(' ', '_') !== pageName) {
        throw new Error(`Wikipedia rendered content was unavailable for ${pageName}`);
    }
    const $ = load(data.parse.text['*']);
    const content = $('.current-events-content');
    if (content.length !== 1) {
        throw new Error(`Wikipedia current events body was not found for ${pageName}`);
    }
    content.find('style, script').remove();
    content.find('[href], [src], [poster]').each((_, element) => {
        const node = $(element);
        const streamLines = ['href', 'src', 'poster'];
        for (const attribute of streamLines) {
            const value = node.attr(attribute);
            if (value) {
                node.attr(attribute, new URL(value, `https://en.wikipedia.org/wiki/${pageName}`).href);
            }
        }
    });
    return content.text().trim() ? content.html()! : '';
}
// Midnight UTC, matching the UTC getters in getCurrentEventsDatePath.
function parseUTCDay(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return null;
    }
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Rejects out-of-range days such as 2025-02-30, which Date would roll over into March
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}
export function parseDateRange(dateRange: string): Date[] | null {
    if (!dateRange || typeof dateRange !== 'string') {
        return null;
    }
    const parts = dateRange.split(':');
    if (parts.length === 1) {
        const date = parseUTCDay(parts[0]);
        return date ? [date] : null;
    }
    if (parts.length === 2) {
        const startDate = parseUTCDay(parts[0]);
        const endDate = parseUTCDay(parts[1]);
        if (!startDate || !endDate) {
            return null;
        }
        const actualStart = new Date(Math.min(startDate.getTime(), endDate.getTime()));
        const actualEnd = new Date(Math.max(startDate.getTime(), endDate.getTime()));
        const dates: Date[] = [];
        const currentDate = new Date(actualEnd);
        while (currentDate >= actualStart) {
            dates.push(new Date(currentDate));
            currentDate.setUTCDate(currentDate.getUTCDate() - 1);
        }
        return dates;
    }
    return null;
}
// The API accepts at most 50 titles per query for unauthenticated clients, and a wide dateRange
// backfill asks for far more than that.
const MAX_TITLES_PER_REQUEST = 50;
async function fetchMultipleWikiContent(pageNames: string[]): Promise<Record<string, string>> {
    const publishedPages = new Map<string, number>();
    for (let i = 0; i < pageNames.length; i += MAX_TITLES_PER_REQUEST) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await fetchPublishedPages(pageNames.slice(i, i + MAX_TITLES_PER_REQUEST));
        for (const [pageName, revid] of batch) {
            publishedPages.set(pageName, revid);
        }
    }
    // Days keep being edited well after they end, so the rendered HTML is keyed by revision: an edit
    // yields a new key instead of serving a version cached before it.
    const results = await unwrapFirstFailure(
        pMap(
            publishedPages,
            async ([pageName, revid]) => [pageName, await cache.tryGet(`wikipedia:current-events:article:${pageName}:${revid}`, async () => await getRenderedWikiContent(pageName, revid), config.cache.contentExpire)] as const,
            {
                concurrency: 3,
                stopOnError: false,
            }
        )
    );
    return Object.fromEntries(results);
}
// Returns the pages among pageNames whose wikitext holds at least one item, with their latest revision id.
async function fetchPublishedPages(pageNames: string[]): Promise<Map<string, number>> {
    const url = 'https://en.wikipedia.org/w/api.php';
    const titles = pageNames.join('|');
    const publishedPages = new Map<string, number>();
    let continueParams: Record<string, string> = {};
    let hasMore = true;
    while (hasMore) {
        const searchParams = {
            action: 'query',
            format: 'json',
            titles,
            prop: 'revisions',
            rvprop: 'ids|content',
            rvslots: 'main',
            ...continueParams,
        };
        // eslint-disable-next-line no-await-in-loop
        const response = await got(url, {
            searchParams,
            headers: {
                'User-Agent': config.trueUA,
            },
        });
        const data = JSON.parse(response.body);
        if (data.query && data.query.pages) {
            const streamLines = Object.values<{
                title: string;
                revisions: Array<{
                    revid: number;
                    slots: {
                        main: Record<string, string>;
                    };
                }>;
            }>(data.query.pages);
            for (const page of streamLines) {
                if (!(page.revisions && page.revisions[0] && page.revisions[0].slots && page.revisions[0].slots.main)) {
                    continue;
                }
                const wikitext = page.revisions[0].slots.main['*'];
                // Parse the Current events template content
                const content = parseCurrentEventsTemplate(wikitext);
                if (!content) {
                    continue;
                }
                // Use the page title as the key
                const pageTitle = page.title;
                // Convert back to the format we expect: "Portal:Current_events/2025_September_18"
                const normalizedTitle = pageTitle.replace(/Portal:Current events\/(\d{4}) (\w+) (\d+)/, 'Portal:Current_events/$1_$2_$3');
                publishedPages.set(normalizedTitle, page.revisions[0].revid);
            }
        }
        // Check for continuation
        if (data.continue) {
            continueParams = data.continue;
        } else {
            hasMore = false;
        }
    }
    return publishedPages;
}
export const route: Route = {
    path: '/current-events/:dateRange?/:includeToday?',
    categories: ['new-media'],
    example: '/wikipedia/current-events',
    parameters: {
        dateRange: {
            description: 'Date range in YYYY-MM-DD format. Can be a single date (e.g., "2025-01-15") or a range with colon separator (e.g., "2025-01-15:2025-01-20"). If omitted, defaults to last 7 days behavior.',
            default: '',
        },
        includeToday: {
            description:
                'Hours after a day starts (00:00 UTC) before it enters the feed, also used as its pubDate. A day keeps changing until it ends at GMT-12, 36 hours after it starts, and most readers keep the first version they see. Applies to dateRange too. Can be given alone, e.g. /current-events/18',
            default: 'auto',
            options: [
                {
                    label: 'Auto (include after 18:00 UTC)',
                    value: 'auto',
                },
                {
                    label: 'Always include current day',
                    value: 'always',
                },
                {
                    label: 'Never include current day',
                    value: 'never',
                },
                {
                    label: 'Include after a delay in hours (0-36)',
                    value: '0-36',
                },
            ],
        },
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['en.wikipedia.org/wiki/Portal:Current_events'],
            target: '/current-events',
        },
    ],
    name: 'Current Events',
    maintainers: ['aavanian'],
    handler,
    description: 'Wikipedia Portal: Current events - Latest news and events. By default shows the past 7 days, or specify a custom date range.',
};
async function handler(ctx) {
    let dateRangeParam = ctx.req.param('dateRange');
    let includeToday = ctx.req.param('includeToday') ?? 'auto';
    // Dates always contain '-' and includeToday values never do, so a lone segment without one,
    // as in /current-events/18, is the includeToday value
    if (dateRangeParam && !dateRangeParam.includes('-') && !ctx.req.param('includeToday')) {
        includeToday = dateRangeParam;
        dateRangeParam = undefined;
    }
    const delayHours = parseDelayHours(includeToday);
    let dates: Date[];
    if (dateRangeParam) {
        const parsedDates = parseDateRange(dateRangeParam);
        if (!parsedDates) {
            throw new InvalidParameterError(`Invalid date range format: ${dateRangeParam}. Expected single date (YYYY-MM-DD) or range (YYYY-MM-DD:YYYY-MM-DD)`);
        }
        dates = parsedDates.filter((date) => availableAt(date, delayHours) <= Date.now());
    } else {
        dates = determineDates(delayHours);
    }
    // Create array of page names for batch request
    const pageNames = dates.map((date) => getCurrentEventsDatePath(date));
    try {
        // Not cached as a whole: the revision lookup must run on every request so an edited day is picked up
        const contentMap = await fetchMultipleWikiContent(pageNames);
        // Build RSS items from the fetched content
        const items = dates
            .map((date) => {
                const pageName = getCurrentEventsDatePath(date);
                const html = contentMap[pageName];
                if (html) {
                    const year = date.getUTCFullYear();
                    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(date.getUTCDate()).padStart(2, '0');
                    const dateStr = `${year}-${month}-${day}`;
                    return {
                        title: `Current events: ${dateStr}`,
                        link: `https://en.wikipedia.org/wiki/${pageName}`,
                        description: html,
                        // When the day entered the feed, so a reader can tell how complete its copy was
                        pubDate: new Date(availableAt(date, delayHours)),
                        guid: `wikipedia-current-events-${dateStr}`,
                    };
                }
                return null;
            })
            .filter((item) => item !== null);
        return {
            title: 'Wikipedia: Portal: Current events',
            link: 'https://en.wikipedia.org/wiki/Portal:Current_events',
            description: 'Current events from Wikipedia - Latest news and events',
            item: items,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to fetch Wikipedia current events: ${message}`, { cause: error });
    }
}
const HOUR = 60 * 60 * 1000;
// A day's page keeps changing until the day ends at GMT-12, 12:00 UTC the next day, i.e. 36 hours after it starts
const MAX_DELAY_HOURS = 36;
// Hours after a day's 00:00 UTC before it enters the feed
function parseDelayHours(includeToday: string): number {
    switch (includeToday) {
        case 'always':
            return 0;
        case 'never':
            return 24;
        case 'auto':
            // Include after 18:00 UTC (6 PM)
            return 18;
        default: {
            // Anything else is rejected rather than ignored: silently serving the default feed
            // makes a mistyped parameter look like it took effect.
            if (!/^\d+$/.test(includeToday)) {
                throw new InvalidParameterError(`Invalid includeToday: ${includeToday}. Expected 'auto', 'always', 'never', or a delay in hours 0-${MAX_DELAY_HOURS}.`);
            }
            // The pattern above already excludes negatives.
            const delayHours = Number(includeToday);
            if (delayHours > MAX_DELAY_HOURS) {
                throw new InvalidParameterError(`Invalid includeToday delay: ${includeToday}. Expected a delay in hours 0-${MAX_DELAY_HOURS}.`);
            }
            return delayHours;
        }
    }
}
function availableAt(date: Date, delayHours: number): number {
    return date.getTime() + delayHours * HOUR;
}
// The 7 most recent days whose delay has elapsed, each at 00:00 UTC
function determineDates(delayHours: number): Date[] {
    const latest = new Date(Date.now() - delayHours * HOUR);
    latest.setUTCHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
        const date = new Date(latest);
        date.setUTCDate(date.getUTCDate() - i);
        return date;
    });
}
async function unwrapFirstFailure<T>(promise: Promise<T>): Promise<T> {
    try {
        return await promise;
    } catch (error) {
        throw error instanceof AggregateError ? error.errors[0] : error;
    }
}
