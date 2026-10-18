'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, Circle, History, Loader2, Lock, RotateCw, Settings2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  publishedAt: string | null;
  prerelease: boolean;
  signed: boolean;
  size: number;
}

interface ReleasesPayload {
  current: string;
  pending: { tag: string; mode: 'update' | 'rollback'; installOnNextLaunch: boolean } | null;
  releases: ReleaseInfo[];
  error?: string;
}

interface SelectResult {
  ok: boolean;
  restarting?: boolean;
  queued?: boolean;
  error?: string;
}

interface ArenaUpdater {
  releases: () => Promise<ReleasesPayload>;
  select: (payload: { tag: string; action: 'now' | 'later' }) => Promise<SelectResult>;
}

function arenaUpdater(): ArenaUpdater | null {
  return (window as unknown as { arenaUpdater?: ArenaUpdater }).arenaUpdater ?? null;
}

function versionNumbers(version: string): number[] {
  return version.replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = versionNumbers(candidate);
  const b = versionNumbers(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// Release notes are light markdown ("- **Fixed**: ..."). Strip the markers so
// the plain-text preview reads clean.
function plainNotes(body: string): string {
  return body
    .split('\n')
    .map((line) => line.replace(/^- /, '• ').replace(/\*\*/g, '').trimEnd())
    .join('\n')
    .trim();
}

// The versions panel — a desktop-only gear in the header. Lists every GitHub
// release; pre-releases (quarantined) and unsigned legacy releases are shown
// but locked. Hovering a version previews its release notes; picking a
// different version and saving asks Restart now (silent install + relaunch)
// or "on next launch", which queues the payload to self-install at relaunch.
export function VersionSettings() {
  // Window access must wait for the client — the site layout is server
  // rendered first, and the bridge only exists in the desktop app anyway.
  const [bridge, setBridge] = React.useState<ArenaUpdater | null>(null);
  React.useEffect(() => {
    setBridge(arenaUpdater());
  }, []);
  const [open, setOpen] = React.useState(false);

  if (!bridge) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-edge bg-void-850 text-ink-300 transition hover:border-edge-hi hover:text-white"
        aria-label="Versions"
        title="Versions"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
      <VersionsDialog bridge={bridge} open={open} onOpenChange={setOpen} />
    </>
  );
}

function VersionsDialog({
  bridge,
  open,
  onOpenChange,
}: {
  bridge: ArenaUpdater;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = React.useState<ReleasesPayload | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<ReleaseInfo | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    setConfirming(false);
    try {
      const payload = await bridge.releases();
      if (payload.error && payload.releases.length === 0) {
        setError(payload.error);
      } else {
        setData(payload);
        const queued = payload.pending?.installOnNextLaunch ? payload.pending.tag : null;
        setSelected(queued ?? `v${payload.current}`);
      }
    } catch {
      setError('Could not reach GitHub for the release list.');
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const currentTag = data ? `v${data.current}` : '';
  const releases = data?.releases ?? [];
  const selectedRelease = releases.find((entry) => entry.tag === selected) ?? null;
  const previewRelease = hovered ?? selectedRelease;
  const queuedTag = data?.pending?.installOnNextLaunch ? data.pending.tag : null;
  const saveable =
    selected !== null &&
    selected !== currentTag &&
    selected !== queuedTag &&
    !busy;

  const apply = React.useCallback(
    async (action: 'now' | 'later') => {
      if (!selected) return;
      setBusy(true);
      setMessage(null);
      try {
        const result = await bridge.select({ tag: selected, action });
        if (!result.ok) {
          setMessage({ kind: 'err', text: result.error ?? 'Something went wrong.' });
          setBusy(false);
          return;
        }
        if (action === 'now') {
          setMessage({ kind: 'ok', text: 'Restarting…' });
          return; // the app quits momentarily; no busy reset needed
        }
        setMessage({ kind: 'ok', text: `${selected} queued — it installs on the next launch.` });
        setConfirming(false);
        window.setTimeout(() => onOpenChange(false), 1600);
      } catch {
        setMessage({ kind: 'err', text: 'The version switch request failed.' });
        setBusy(false);
      }
    },
    [bridge, selected, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <header className="shrink-0 border-b border-edge bg-void-800 px-4 py-3.5 sm:px-6 sm:pt-5">
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-volt" />
            Versions
          </DialogTitle>
          <DialogDescription className="mt-1">
            Run any signed release — upgrade or downgrade. Pre-releases are listed but locked.
          </DialogDescription>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {loading && !data ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="skeleton h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : error ? (
            <div className="space-y-3 py-8 text-center">
              <p className="text-sm text-ink-400">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
              {/* The dropdown-style list. Hover drives the notes preview. */}
              <div
                className="max-h-[46vh] space-y-1.5 overflow-y-auto rounded-xl border border-edge bg-void-950 p-1.5"
                role="listbox"
                aria-label="Versions"
                onMouseLeave={() => setHovered(null)}
              >
                {releases.map((release) => {
                  const locked = release.prerelease || !release.signed;
                  const isSelected = release.tag === selected;
                  const isQueued = release.tag === queuedTag;
                  const upgrade = isNewer(release.tag, currentTag);
                  const downgrade = isNewer(currentTag, release.tag);
                  return (
                    <button
                      key={release.tag}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={locked}
                      onMouseEnter={() => setHovered(release)}
                      onClick={() => {
                        if (locked) return;
                        setSelected(release.tag);
                        setConfirming(false);
                        setMessage(null);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all duration-200',
                        locked
                          ? 'cursor-not-allowed border-transparent bg-void-900 opacity-45'
                          : isSelected
                            ? 'border-volt bg-void-800'
                            : 'border-transparent hover:border-edge-hi hover:bg-void-800',
                      )}
                    >
                      <Circle
                        className={cn(
                          'h-2 w-2 shrink-0',
                          isSelected ? 'fill-volt text-volt' : 'text-ink-500',
                          locked && 'text-ink-500',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-white">{release.tag}</span>
                          {release.tag === currentTag ? (
                            <span className="rounded-md bg-volt px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-void">
                              Running
                            </span>
                          ) : null}
                          {isQueued ? (
                            <span className="rounded-md bg-live px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-void">
                              Queued
                            </span>
                          ) : null}
                          {locked ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-void-700 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-300">
                              <Lock className="h-2.5 w-2.5" />
                              {release.prerelease ? 'Pre-release' : 'Unsigned'}
                            </span>
                          ) : null}
                          {!locked && upgrade ? <ArrowUp className="h-3 w-3 text-ink-300" aria-label="Upgrade" /> : null}
                          {!locked && downgrade ? <ArrowDown className="h-3 w-3 text-ink-300" aria-label="Downgrade" /> : null}
                        </span>
                        <span className="mt-0.5 block text-[10px] uppercase tracking-[0.14em] text-ink-500">
                          {formatDate(release.publishedAt)}
                          {isQueued ? ' · installs next launch' : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {releases.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-ink-500">No releases found.</p>
                ) : null}
              </div>

              {/* Hover-driven release notes preview. */}
              <div className="flex min-h-[220px] flex-col rounded-xl border border-edge bg-void-900 p-4 lg:max-h-[46vh]">
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">What changed</p>
                <p className="mt-1.5 font-mono text-sm font-bold text-white">{previewRelease?.tag ?? '—'}</p>
                <div className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-300">
                  {previewRelease ? plainNotes(previewRelease.body) || 'No release notes for this version.' : 'Hover a version to preview its changes.'}
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-edge bg-void-800 px-4 py-3.5 sm:px-6">
          {message ? (
            <div className="flex min-h-9 items-center justify-between gap-3">
              <p className={cn('text-xs', message.kind === 'ok' ? 'text-volt' : 'text-flare')}>{message.text}</p>
              {message.kind === 'ok' && message.text.includes('queued') ? null : null}
            </div>
          ) : confirming && selected ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-xs text-ink-300">
                Apply <span className="font-mono font-bold text-white">{selected}</span> — restart now or on next launch?
              </p>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void apply('now')}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Restart now
              </Button>
              <Button variant="soft" size="sm" disabled={busy} onClick={() => void apply('later')}>
                On next launch
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-ink-500">
                {data ? (
                  <>
                    Running <span className="font-mono text-ink-300">{currentTag}</span>
                    {queuedTag ? (
                      <>
                        {' '}· <span className="font-mono text-ink-300">{queuedTag}</span> queued for next launch
                      </>
                    ) : null}
                  </>
                ) : (
                  ' '
                )}
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={!saveable}
                onClick={() => {
                  setConfirming(true);
                  setMessage(null);
                }}
              >
                Save
              </Button>
            </div>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
