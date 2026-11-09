// The app on its own.
//
// One switch turns the app away from every outside service: the board comes
// from the scoreboards the app reads itself, the feed comes from the
// broadcaster's own pages, and the sources are the user's own. No mirror, no
// provider, no API - and when the app cannot reach the broadcast, it says
// so instead of falling back to something else behind the user's back.
//
// The switch can be set in two ways:
//
//   ARENA_STRICT_DIRECT=1        in the environment (it wins)
//   "strict": true               in the app's own settings file
//
// The environment is an instruction; the file is a preference. An instruction
// is obeyed even when the preference says otherwise.

import { personalSources } from '@/lib/server/media/sources';

const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off']);

/** True when the app must not contact anybody but the user and the carrier. */
export async function strictMode(): Promise<boolean> {
  const env = process.env.ARENA_STRICT_DIRECT?.trim().toLowerCase();
  if (env && ON.has(env)) return true;
  if (env && OFF.has(env)) return false;

  try {
    const { config } = await personalSources();
    return config.strict === true;
  } catch {
    return false;
  }
}

/** True when the environment carries the switch itself. */
export function strictModeFromEnvironment(): boolean | null {
  const env = process.env.ARENA_STRICT_DIRECT?.trim().toLowerCase();
  if (!env) return null;
  if (ON.has(env)) return true;
  if (OFF.has(env)) return false;
  return null;
}
