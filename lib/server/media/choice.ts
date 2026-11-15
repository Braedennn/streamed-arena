// Which service the user picked for a match.
//
// The app resolves a match by itself: every provider that knows the two teams
// is asked, every feed is measured, and the best one is read. That is the
// default, and it is what the app does on its own.
//
// The user can say "this service instead" - the app then reads that
// service's door of the match first and keeps the other doors behind it, to
// be used when the chosen one stops answering. The choice is remembered for
// as long as the app runs, for the match it was made for: a choice made for
// one game says nothing about the next one.

const CHOICES_KEY = '__arena_service_choice__';

/** The choice that means "the app decides". */
export const AUTO = 'auto';

function choices(): Map<string, string> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[CHOICES_KEY];
  if (existing instanceof Map) return existing as Map<string, string>;
  const created = new Map<string, string>();
  store[CHOICES_KEY] = created;
  return created;
}

/** The service picked for a match, or "auto" when none was. */
export function choiceFor(streamKey: string): string {
  if (!streamKey) return AUTO;
  return choices().get(streamKey) ?? AUTO;
}

/**
 * Picks a service for a match, or gives the match back to the app.
 *
 * "auto" is the app's own choice: the best door of any service.
 */
export function setChoice(streamKey: string, service: string): string {
  if (!streamKey) return AUTO;
  const wanted = service.trim().toLowerCase();
  if (!wanted || wanted === AUTO) {
    choices().delete(streamKey);
    return AUTO;
  }
  choices().set(streamKey, wanted);
  return wanted;
}

/** Forgets the choice made for a match. */
export function clearChoice(streamKey: string): void {
  if (!streamKey) return;
  choices().delete(streamKey);
}
