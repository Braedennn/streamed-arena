// Server-side ESPN proxy for the game summary (box score + leaders).
// Same rationale as the scoreboard proxy: the renderer cannot fetch ESPN
// cross-origin, the server can.

import { espnSummaryJson } from '@/lib/espn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEGMENT = /^[a-zA-Z0-9._-]{1,64}$/;
const EVENT_ID = /^\d{1,12}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get('sport') ?? '';
  const league = searchParams.get('league') ?? '';
  const event = searchParams.get('event') ?? '';

  if (!SEGMENT.test(sport) || !SEGMENT.test(league) || !EVENT_ID.test(event)) {
    return Response.json({ error: 'sport, league and event are required' }, { status: 400 });
  }

  try {
    const data = await espnSummaryJson(sport, league, event);
    return Response.json(
      data,
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ESPN request failed';
    return Response.json({ error: message }, { status: 504 });
  }
}
