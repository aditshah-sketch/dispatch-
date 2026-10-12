import "server-only";
import { analyzeArticles } from "../../domain/analysis";
import { refsFromPreviousEditions } from "../../domain/history";
import { currentPublishDate, milestonesFor } from "../../domain/schedule";
import { contentFingerprint, truncate } from "../../domain/text";
import { classifyTopicByRules } from "../../domain/topics";
import { hostnameOf, normalizeUrl } from "../../domain/url";
import { config } from "../config";
import type { Db } from "../db/client";
import { fetchFeed, parseFeed, searchGNews, type FeedItem } from "../providers/feeds";
import { fetchArticlePage, fetchRawViaScrapingBee } from "../providers/scrapingbee";
import {
  articlesNeedingContent,
  articlesSince,
  finishRun,
  listSources,
  recordSourceResult,
  saveClusters,
  saveExtraction,
  saveTopics,
  startRun,
  upsertArticle,
} from "../repo/articles";
import { coveredRefs, ensureEdition } from "../repo/editions";
import { audit, markHealth } from "../repo/ops";
import { getSettings } from "../repo/settings";

// Hosts known to be paywalled: never spend scraping credits trying to get
// around them; the feed summary is used and the limitation recorded.
const PAYWALLED_HOSTS = new Set(["the-ken.com", "theken.com", "the-arc.in", "mint-pro.livemint.com"]);

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface IngestionResult {
  runId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  stats: Record<string, number>;
  summary: string;
}

export async function runIngestion(db: Db, opts: { trigger: string; now?: Date; onStage?: (s: string) => Promise<void> }): Promise<IngestionResult> {
  const now = opts.now ?? new Date();
  const settings = await getSettings(db);
  const publishDate = currentPublishDate(now, settings.schedule);
  const m = milestonesFor(publishDate, settings.schedule);
  await ensureEdition(db, publishDate);
  const runId = await startRun(db, publishDate, opts.trigger);
  const stage = async (s: string) => opts.onStage?.(s);
  const deadline = Date.now() + 200_000;

  const sources = (await listSources(db)).filter((s) => s.enabled);
  const gnews = config.newsApi();
  const stats = { fetched: 0, inserted: 0, existing: 0, invalid: 0, sourcesOk: 0, sourcesFailed: 0, sourcesSkipped: 0, pagesFetched: 0, pagesFailed: 0, credits: 0 };
  const sourceResults: Array<{ sourceId: string; name: string; status: string; items: number; error: string | null }> = [];

  await stage(`Fetching ${sources.length} sources…`);
  // One source failing never fails the run: every fetch is isolated.
  await mapLimit(sources, 4, async (src) => {
    let items: FeedItem[] = [];
    try {
      if (src.kind === "rss") {
        let feed: Awaited<ReturnType<typeof fetchFeed>>;
        try {
          feed = await fetchFeed(src.locator);
        } catch (e) {
          // Some publishers block cloud IPs (HTTP 403/429). Relay the same feed
          // through ScrapingBee if configured; otherwise report the failure.
          const sb = config.scrapingBee();
          if (!sb.ok || !/HTTP (401|403|429)/.test((e as Error).message)) throw e;
          feed = parseFeed(await fetchRawViaScrapingBee(sb.value!.apiKey, src.locator));
          stats.credits += 1;
        }
        items = feed.items.map((i) => ({ ...i, publisher: src.name }));
      } else {
        if (!gnews.ok) {
          await recordSourceResult(db, src.id, { status: "SKIPPED", error: "News search not configured (GNEWS_API_KEY)", count: null });
          stats.sourcesSkipped++;
          sourceResults.push({ sourceId: src.id, name: src.name, status: "SKIPPED", items: 0, error: "not configured" });
          return;
        }
        items = (await searchGNews(gnews.value!.apiKey, src.locator, m.collectionWindowStart)).items;
      }
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "Timed out" : (e as Error).message;
      stats.sourcesFailed++;
      await recordSourceResult(db, src.id, { status: "FAILED", error: msg, count: null });
      sourceResults.push({ sourceId: src.id, name: src.name, status: "FAILED", items: 0, error: msg });
      if (src.kind === "news_query") await markHealth(db, "news_api", false, msg);
      return;
    }

    let kept = 0;
    for (const item of items) {
      const normalized = normalizeUrl(item.url);
      if (!normalized || !item.title) {
        stats.invalid++;
        continue;
      }
      // Skip items far older than this edition's window (feeds keep archives).
      if (item.publishedAt && Date.parse(item.publishedAt) < Date.parse(m.collectionWindowStart) - 7 * 86_400_000) continue;
      stats.fetched++;
      kept++;
      const notes = [item.dateNote].filter((n): n is string => !!n);
      const r = await upsertArticle(db, {
        sourceId: src.id,
        publisher: item.publisher ?? hostnameOf(item.url) ?? src.name,
        url: item.url,
        normalizedUrl: normalized,
        headline: item.title,
        author: item.author,
        publishedAt: item.publishedAt,
        description: item.description,
        extractedText: item.content,
        fingerprint: contentFingerprint(item.title, item.description ?? item.content),
        extractionStatus: item.content ? "EXTRACTED" : "FEED_ONLY",
        provenance: src.kind === "rss" ? "rss" : "news_api",
        evidenceNotes: notes,
      });
      if (r.inserted) stats.inserted++;
      else stats.existing++;
    }
    stats.sourcesOk++;
    await recordSourceResult(db, src.id, { status: kept ? "OK" : "EMPTY", error: null, count: kept });
    sourceResults.push({ sourceId: src.id, name: src.name, status: kept ? "OK" : "EMPTY", items: kept, error: null });
    if (src.kind === "news_query") await markHealth(db, "news_api", true);
  });
  if (stats.sourcesOk > 0) await markHealth(db, "rss", true);

  // Selective page retrieval: only thin articles in this window, within the
  // configured credit budget and time budget, cached by never re-attempting.
  const sb = config.scrapingBee();
  if (sb.ok) {
    const candidates = await articlesNeedingContent(db, m.collectionWindowStart, sb.value!.maxPagesPerRun * 2);
    const toFetch: typeof candidates = [];
    for (const a of candidates) {
      const host = hostnameOf(a.url) ?? "";
      if (PAYWALLED_HOSTS.has(host)) {
        await saveExtraction(db, a.id, { status: "BLOCKED", text: null, note: "Paywalled publisher — public summary only" });
      } else if (toFetch.length < sb.value!.maxPagesPerRun) toFetch.push(a);
    }
    if (toFetch.length) await stage(`Retrieving ${toFetch.length} article pages with ScrapingBee…`);
    await mapLimit(toFetch, 3, async (a) => {
      if (Date.now() > deadline) return;
      const r = await fetchArticlePage(sb.value!.apiKey, a.url, { renderJs: sb.value!.renderJs });
      stats.credits += r.credits ?? 0;
      if (r.status === "EXTRACTED" || r.status === "PARTIAL") stats.pagesFetched++;
      else stats.pagesFailed++;
      await saveExtraction(db, a.id, { status: r.status, text: r.text ? truncate(r.text, 20000) : null, note: r.note });
    });
    if (toFetch.length) await markHealth(db, "scrapingbee", stats.pagesFetched > 0 || stats.pagesFailed === 0, stats.pagesFetched ? null : "No pages retrieved");
  }

  // Deterministic topic labels and event clusters for everything in the window.
  await stage("Detecting duplicates and same-event coverage…");
  const articles = await articlesSince(db, m.collectionWindowStart);
  await saveTopics(
    db,
    articles.filter((a) => !a.topic).map((a) => ({ id: a.id, topic: classifyTopicByRules(`${a.headline} ${a.description ?? ""}`), origin: "rules" as const })),
  );
  const { refs } = refsFromPreviousEditions(await coveredRefs(db), publishDate);
  const analysis = analyzeArticles(articles, { refs, windowStart: m.collectionWindowStart, edition: null, now });
  await saveClusters(db, analysis.clusterOf);

  const status: IngestionResult["status"] = stats.sourcesOk === 0 ? "FAILED" : stats.sourcesFailed > 0 ? "PARTIAL" : "SUCCEEDED";
  await finishRun(db, runId, status, stats, sourceResults);
  const summary = `Collected ${stats.fetched} items from ${stats.sourcesOk} sources: ${stats.inserted} new, ${stats.existing} already stored${stats.sourcesFailed ? `, ${stats.sourcesFailed} source${stats.sourcesFailed > 1 ? "s" : ""} failed` : ""}. ${analysis.counts.eligible} eligible events.`;
  await audit(db, { actor: opts.trigger === "schedule" ? "scheduler" : "owner", action: "collect.finished", message: summary, details: stats });
  if (status === "FAILED") await markHealth(db, "rss", false, "No source could be fetched");
  return { runId, status, stats, summary };
}
