// Server-side ESPN proxy — the renderer cannot reliably reach ESPN directly:
// site.api.espn.com rejects fetches from the app's http://127.0.0.1 origin
// (no Access-Control-Allow-Origin on the response), so the live stat panel
// starves in the packaged desktop app. Node's fetch on the app's own server
// talks to ESPN fine, and the web deployment benefits identically — same
// origin, no CORS surface, and the client keeps its usual TTL/polling.
//
// Query-validated passthrough: sport/league/event go straight into a fixed
// ESPN path, so segments are strictly limited to URL-safe id chars.

import { espnScoreboardJson } from '@/lib/espn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEGMENT = /^[a-zA-Z0-9._-]{1,64}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get('sport') ?? '';
  const league = searchParams.get('league') ?? '';
  const dates = searchParams.get('dates') ?? '';

  if (!SEGMENT.test(sport) || !SEGMENT.test(league)) {
    return Response.json({ error: 'sport and league are required' }, { status: 400 });
  }

  try {
    const events = await espnScoreboardJson(sport, league, dates ? dates : undefined);
    return Response.json(
      { events },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ESPN request failed';
    return Response.json({ error: message }, { status: 504 });
  }
}
