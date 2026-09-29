import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { type MatchStatus, type Sport } from '@/lib/types';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const FALLBACK_SPORTS: readonly Sport[] = [
  { id: 'football', name: 'Football' },
  { id: 'basketball', name: 'Basketball' },
  { id: 'american-football', name: 'American Football' },
  { id: 'hockey', name: 'Hockey' },
  { id: 'baseball', name: 'Baseball' },
  { id: 'motor-sports', name: 'Motor Sports' },
  { id: 'fight', name: 'Fight (UFC, Boxing)' },
  { id: 'tennis', name: 'Tennis' },
  { id: 'cricket', name: 'Cricket' },
  { id: 'other', name: 'Other' },
];

const titleCase = (value: string): string =>
  value
    .split('-')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');

export function sportName(category: string, sports: readonly Sport[]): string {
  const match = sports.find((sport) => sport.id === category);
  return match?.name ?? titleCase(category);
}

export function initials(name: string): string {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

export function splitTitle(title: string): { home: string; away: string } {
  const index = title.indexOf(' vs ');
  if (index === -1) return { home: title, away: 'TBD' };
  return { home: title.slice(0, index).trim(), away: title.slice(index + 4).trim() };
}

const LIVE_WINDOW_MS = 1000 * 60 * 60 * 3.5;

export function deriveStatus(date: number, isLive: boolean, now: number): MatchStatus {
  if (isLive) return 'live';
  const delta = date - now;
  if (delta > 0) return 'upcoming';
  if (delta > -LIVE_WINDOW_MS) return 'in-play';
  return 'ended';
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface KickoffParts {
  readonly dayLabel: string;
  readonly timeLabel: string;
  readonly sameDay: boolean;
  readonly tomorrow: boolean;
}

export function kickoffParts(date: number, now: number): KickoffParts {
  const target = new Date(date);
  const current = new Date(now);
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const startOfCurrent = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const dayDelta = Math.round((startOfTarget - startOfCurrent) / 86_400_000);

  if (dayDelta === 0) return { dayLabel: 'Today', timeLabel: timeFormatter.format(target), sameDay: true, tomorrow: false };
  if (dayDelta === 1) return { dayLabel: 'Tomorrow', timeLabel: timeFormatter.format(target), sameDay: false, tomorrow: true };
  return { dayLabel: dateFormatter.format(target), timeLabel: timeFormatter.format(target), sameDay: false, tomorrow: false };
}

export interface CountdownParts {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly totalMs: number;
  readonly done: boolean;
}

export function countdownParts(target: number, now: number): CountdownParts {
  const totalMs = Math.max(0, target - now);
  const totalSeconds = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalMs,
    done: totalMs <= 0,
  };
}

export function compactCountdown(parts: CountdownParts): string {
  if (parts.done) return 'Underway';
  if (parts.days > 0) return `${parts.days}d ${parts.hours}h`;
  if (parts.hours > 0) return `${parts.hours}h ${String(parts.minutes).padStart(2, '0')}m`;
  if (parts.minutes > 0) return `${parts.minutes}m ${String(parts.seconds).padStart(2, '0')}s`;
  return `${parts.seconds}s`;
}

export function formatViewers(value?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
  return String(value);
}

export function slugSource(source: string): string {
  return source.toUpperCase().slice(0, 7);
}

export function streamKey(source: string, streamNo: number, id: string): string {
  return `${source}::${streamNo}::${id}`;
}
