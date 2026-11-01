// The feeds the arena does not carry, by stream key.
//
// GET /api/refused
//
// A feed the provider labels with a blocked broadcaster, and a feed for a
// game ESPN offers as SkyCast (the college football alternate with the
// picture and the crowd but no announcers). The board hides them so they
// never reach the player.

import { refusedStreamKeys } from '@/lib/server/streamfree';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const keys = await refusedStreamKeys();
    return Response.json(
      { keys },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    return Response.json({ error: message, keys: [] }, { status: 504 });
  }
}
