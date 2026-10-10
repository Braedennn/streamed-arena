export function watchHref(id: string): string {
  return `/watch?id=${encodeURIComponent(id)}`;
}

export function sportHref(sport: string): string {
  return `/sports?sport=${encodeURIComponent(sport)}`;
}
