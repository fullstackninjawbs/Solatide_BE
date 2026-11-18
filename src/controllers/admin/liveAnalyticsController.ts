/**
 * Admin live customer activity (dashboard):
 *   GET /api/admin/analytics/live/visitors   recent visitor cards + who is active now
 *   GET /api/admin/analytics/live/activity   "All activity" feed: newest first, filters, search, paging
 *   GET /api/admin/analytics/live/stream     Server-Sent Events: every new action as it is recorded
 *
 * Only recorded activity is shown (events with an id, never inferred steps). Browser-reported
 * purchase events from before the server recorded payments are excluded.
 */
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import catchAsync from '../../utils/catchAsync';
import AnalyticsEvent, { ANALYTICS_EVENT_TYPES } from '../../models/analyticsEvent.model';
import { AnalyticsSession } from '../../models/analyticsSession.model';
import Order from '../../models/order.model';
import { liveStatus, SESSION_TIMEOUT_MS } from '../../services/analytics/config';
import { visitorCard, visitorSummary, activityItem, liveDefinitions } from '../../services/analytics/live/cards';
import { subscribe, markViewerPresent, LiveMessage } from '../../services/analytics/live/bus';

const RECENT_CARDS_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEARCH_SESSIONS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_FIELDS =
  'sessionId visitorId startedAt lastActivityAt leftAt isNewVisitor landingPage source device geo counts lastEvent cart checkout identity orderIds';
const SUMMARY_FIELDS = 'sessionId visitorId isNewVisitor source device geo identity';

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Recent visitor cards (most recently active first) and the presence list for "online now". */
export const getLiveVisitors = catchAsync(async (req: Request, res: Response) => {
  const now = Date.now();
  const limit = clampInt(req.query.limit, 1, 12, 6);
  const [recent, open] = await Promise.all([
    AnalyticsSession.find({ lastActivityAt: { $gte: new Date(now - RECENT_CARDS_WINDOW_MS) } })
      .sort({ lastActivityAt: -1 })
      .limit(limit)
      .select(SESSION_FIELDS)
      .lean(),
    // Every open visit, for the live "online now" count (the page re-checks statuses as time passes)
    AnalyticsSession.find({ lastActivityAt: { $gte: new Date(now - SESSION_TIMEOUT_MS) } })
      .sort({ lastActivityAt: -1 })
      .limit(2000)
      .select('sessionId lastActivityAt leftAt')
      .lean(),
  ]);
  const presence = open.map((s: any) => ({
    sessionId: s.sessionId,
    lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : undefined,
    leftAt: s.leftAt ? new Date(s.leftAt).toISOString() : undefined,
  }));
  res.status(200).json({
    success: true,
    data: {
      serverTime: new Date(now).toISOString(),
      definitions: liveDefinitions(),
      onlineNow: open.filter((s: any) => liveStatus(s, now) === 'active').length,
      visitors: recent.map((s: any) => visitorCard(s, now)),
      presence,
    },
  });
});

/** One visit's card (the visitor panel opened from the feed or a card). */
export const getLiveVisitor = catchAsync(async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    res.status(400).json({ success: false, message: 'Invalid session' });
    return;
  }
  const session = await AnalyticsSession.findOne({ sessionId }).select(SESSION_FIELDS).lean();
  if (!session) {
    res.status(404).json({ success: false, message: 'Visit not found' });
    return;
  }
  res.status(200).json({ success: true, data: { serverTime: new Date().toISOString(), definitions: liveDefinitions(), visitor: visitorCard(session) } });
});

/** "All activity": newest first; ?before=<cursor>&limit=&types=a,b&q=&sessionId= */
export const getLiveActivity = catchAsync(async (req: Request, res: Response) => {
  const limit = clampInt(req.query.limit, 1, 100, 30);
  const and: Record<string, unknown>[] = [{ eventId: { $type: 'string' } }, { clientReported: { $ne: true } }];

  const types = String(req.query.types || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => (ANALYTICS_EVENT_TYPES as readonly string[]).includes(t));
  if (types.length) and.push({ eventType: { $in: types } });

  const sessionId = typeof req.query.sessionId === 'string' && /^[A-Za-z0-9_:-]{8,80}$/.test(req.query.sessionId) ? req.query.sessionId : '';
  if (sessionId) and.push({ sessionId });

  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    const idPrefix = q.replace(/^#/, '').replace(/[^A-Za-z0-9]/g, '');
    const sessions = await AnalyticsSession.find({
      startedAt: { $gte: new Date(Date.now() - SEARCH_SESSIONS_WINDOW_MS) },
      $or: [
        { 'identity.name': re },
        { 'identity.email': re },
        ...(idPrefix.length >= 3 ? [{ visitorId: new RegExp(`^${escapeRegex(idPrefix)}`, 'i') }, { sessionId: new RegExp(`^${escapeRegex(idPrefix)}`, 'i') }] : []),
        { 'geo.city': re },
        { 'geo.country': re },
      ],
    })
      .limit(500)
      .select('sessionId')
      .lean();
    and.push({ $or: [{ productName: re }, { path: re }, { sessionId: { $in: sessions.map((s: any) => s.sessionId) } }] });
  }

  const before = typeof req.query.before === 'string' ? req.query.before.match(/^(\d{10,16})_([a-f0-9]{24})$/i) : null;
  if (before) {
    const ts = new Date(Number(before[1]));
    const id = new mongoose.Types.ObjectId(before[2]);
    and.push({ $or: [{ timestamp: { $lt: ts } }, { timestamp: ts, _id: { $lt: id } }] });
  }

  const rows: any[] = await AnalyticsEvent.find({ $and: and }).sort({ timestamp: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const sessionIds = [...new Set(page.map((e) => e.sessionId).filter((s) => s && !s.startsWith('order:')))];
  const orderIds = [...new Set(page.map((e) => e.orderId).filter(Boolean).map(String))];
  const [sessions, orders] = await Promise.all([
    sessionIds.length ? AnalyticsSession.find({ sessionId: { $in: sessionIds } }).select(SUMMARY_FIELDS).lean() : [],
    orderIds.length ? Order.find({ _id: { $in: orderIds } }).select('orderNumber').lean() : [],
  ]);
  const summaries = new Map((sessions as any[]).map((s) => [s.sessionId, visitorSummary(s)]));
  const orderNumbers = new Map((orders as any[]).map((o) => [String(o._id), o.orderNumber ? String(o.orderNumber) : undefined]));

  const items = page.map((e) => activityItem(e, summaries.get(e.sessionId) || null, { orderNumber: e.orderId ? orderNumbers.get(String(e.orderId)) : undefined }));
  res.status(200).json({
    success: true,
    data: { serverTime: new Date().toISOString(), items, hasMore, nextCursor: hasMore ? items[items.length - 1]?.cursor : null },
  });
});

// ─── Live stream (Server-Sent Events) ─────────────────────────────────────────

const HEARTBEAT_MS = 20_000; // below nginx's 60 s proxy_read_timeout
const MAX_STREAMS_PER_WORKER = 100;
const openStreams = new Set<Response>();

/**
 * One long-lived response per open dashboard. "Cache-Control: no-transform" keeps the compression
 * middleware from buffering it and "X-Accel-Buffering: no" makes nginx pass each message on at once.
 * The page authenticates with its Bearer token (fetch stream), reconnects by itself and re-reads the
 * snapshot after a reconnect.
 */
export const streamLive = (req: Request, res: Response): void => {
  if (openStreams.size >= MAX_STREAMS_PER_WORKER) {
    res.status(503).json({ success: false, message: 'Too many live connections' });
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.socket.setKeepAlive(true);
  req.socket.setNoDelay(true);

  const write = (chunk: string) => {
    if (!res.writableEnded) res.write(chunk);
  };
  write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ serverTime: new Date().toISOString(), definitions: liveDefinitions() })}\n\n`);
  void markViewerPresent();

  const unsubscribe = subscribe((msg: LiveMessage) => {
    write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    write(`: heartbeat ${Date.now()}\n\n`);
    void markViewerPresent();
  }, HEARTBEAT_MS);

  openStreams.add(res);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    openStreams.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
};

/** Graceful shutdown: end the open streams so the server can close (pages reconnect elsewhere). */
export function closeLiveStreams(): void {
  for (const res of openStreams) {
    try { res.end(); } catch { /* ignore */ }
  }
  openStreams.clear();
}
