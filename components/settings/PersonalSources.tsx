'use client';

import * as React from 'react';
import { Loader2, Plus, RadioTower, RotateCw, Trash2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  readPersonalSources,
  removePersonalSources,
  writePersonalSources,
  type PersonalSources,
} from '@/lib/personal-sources';

// Sources the user brought themselves.
//
// The app is the provider: it hosts every stream itself, fetches the media
// ahead of the player and serves it from its own disk. Where the bytes come
// from is the app's business - and the user can say so. Point the app at a
// feed you own and it hosts that feed, asking nobody else for it.
//
// This panel writes that setting. It talks to the app's own server, which
// keeps it in the app's data directory, so it survives a restart and is the
// same for every user of the app.

interface SourceRow {
  readonly id: string;
  key: string;
  url: string;
}

let rowCounter = 0;
function newRow(key = '', url = ''): SourceRow {
  rowCounter += 1;
  return { id: `row-${rowCounter}`, key, url };
}

function rowsFrom(sources: PersonalSources | null): SourceRow[] {
  if (!sources || sources.matches.length === 0) return [];
  return sources.matches.map((entry) => newRow(entry.key, entry.url));
}

function isManifestUrl(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The button in the header, and the panel behind it. */
export function PersonalSourcesSettings() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-edge bg-void-850 text-ink-300 transition hover:border-edge-hi hover:text-white"
        aria-label="Your own sources"
        title="Your own sources"
      >
        <RadioTower className="h-3.5 w-3.5" />
      </button>
      <PersonalSourcesDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function PersonalSourcesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = React.useState<PersonalSources | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [defaultUrl, setDefaultUrl] = React.useState('');
  const [referer, setReferer] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [strict, setStrict] = React.useState(false);
  const [rows, setRows] = React.useState<SourceRow[]>([]);

  const load = React.useCallback(async () => {
    setLoading(true);
    const sources = await readPersonalSources();
    setData(sources);
    setDefaultUrl(sources?.default ?? '');
    setReferer(sources?.referer ?? '');
    setLabel(sources?.label ?? '');
    setStrict(Boolean(sources?.strict));
    setRows(rowsFrom(sources));
    setLoading(false);
  }, []);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = React.useCallback(async () => {
    const matches: { key: string; url: string }[] = [];
    for (const row of rows) {
      const key = row.key.trim();
      const url = row.url.trim();
      if (!key && !url) continue;
      if (!key || !isManifestUrl(url)) {
        setMessage({
          kind: 'err',
          text: 'Every match needs a name and a manifest URL that starts with http.',
        });
        return;
      }
      matches.push({ key, url });
    }
    if (defaultUrl.trim() && !isManifestUrl(defaultUrl)) {
      setMessage({ kind: 'err', text: 'The default source is not a valid manifest URL.' });
      return;
    }

    setBusy(true);
    setMessage(null);
    const saved = await writePersonalSources({
      default: defaultUrl.trim() || null,
      matches,
      referer: referer.trim() || null,
      label: label.trim() || null,
      strict,
    });
    setBusy(false);
    if (!saved) {
      setMessage({ kind: 'err', text: 'The setting could not be saved.' });
      return;
    }
    setData(saved);
    setStrict(Boolean(saved.strict));
    setMessage({
      kind: 'ok',
      text:
        saved.strictFromEnvironment
          ? 'Saved — but the environment carries the switch itself, and that one wins.'
          : saved.strict
            ? 'Saved — the app is on its own now: no third party is contacted.'
            : saved.origin === 'env'
              ? 'Saved — but the environment carries a source of its own, and that one wins.'
              : saved.configured
                ? 'Saved — the app hosts your own source from now on.'
                : 'Saved.',
    });
  }, [rows, defaultUrl, referer, label, strict]);

  const clear = React.useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const cleared = await removePersonalSources();
    setBusy(false);
    if (!cleared) {
      setMessage({ kind: 'err', text: 'The setting could not be removed.' });
      return;
    }
    setData(cleared);
    setDefaultUrl('');
    setReferer('');
    setLabel('');
    setStrict(false);
    setRows([]);
    setMessage({
      kind: 'ok',
      text: cleared.configured
        ? 'The file is gone — the environment still carries a source of its own.'
        : 'Removed — the app is back to the feed it can find.',
    });
  }, []);

  const field =
    'h-9 w-full rounded-md border border-edge bg-void-950 px-2.5 font-mono text-xs text-white placeholder:text-ink-500 focus:border-edge-hi focus:outline-none';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <header className="shrink-0 border-b border-edge bg-void-800 px-4 py-3.5 sm:px-6 sm:pt-5">
          <DialogTitle className="flex items-center gap-2">
            <RadioTower className="h-4 w-4 text-volt" />
            Your own sources
          </DialogTitle>
          <DialogDescription className="mt-1">
            Point the app at a feed you own and it hosts that feed itself — the bytes come from
            your source and from nowhere else. A match with a source of its own is never looked
            up anywhere else. Or turn the app away from every third party altogether and let it
            read the broadcasters directly.
          </DialogDescription>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-void-900 px-3 py-2">
            <p className="text-xs text-ink-300">
              {loading ? (
                'Reading the setting…'
              ) : data?.configured ? (
                data.origin === 'env' ? (
                  <>
                    A source of your own is in use — set by the environment, so it wins over the
                    file.
                  </>
                ) : (
                  <>A source of your own is in use.</>
                )
              ) : (
                <>No source of your own yet — the app is using the feed it can find.</>
              )}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RotateCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>

          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setStrict((value) => !value)}
              disabled={data?.strictFromEnvironment !== null && data?.strictFromEnvironment !== undefined}
              aria-pressed={strict}
              className={cn(
                'flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                strict
                  ? 'border-volt/60 bg-volt/10'
                  : 'border-edge bg-void-900 hover:border-edge-hi',
                data?.strictFromEnvironment !== null &&
                  data?.strictFromEnvironment !== undefined &&
                  'cursor-not-allowed opacity-70',
              )}
            >
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-white">
                  Never contact a third party
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">
                  The list of games comes from the scoreboards the app reads itself, and the feed comes
                  from the broadcaster’s own pages. When a broadcast sits behind a subscription, the
                  app says so instead of asking anybody else for it. With the switch off the app also
                  asks its own mirror scraper and the provider boards, and offers the sharpest feed
                  it finds.
                </span>
              </span>
              <span
                className={cn(
                  'mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                  strict ? 'border-volt/60 text-volt' : 'border-edge text-ink-400',
                )}
              >
                {strict ? 'On' : 'Off'}
              </span>
            </button>
            {data?.strictFromEnvironment !== null && data?.strictFromEnvironment !== undefined ? (
              <p className="text-[11px] leading-relaxed text-ink-500">
                The environment carries this switch, so it wins over the file.
              </p>
            ) : null}
          </section>

          <section className="space-y-2">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">
              Default source
            </label>
            <input
              className={field}
              value={defaultUrl}
              onChange={(event) => setDefaultUrl(event.target.value)}
              placeholder="https://your-host/live/index.m3u8"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[11px] leading-relaxed text-ink-500">
              Used for any match without a source of its own. The app keeps the feed it can find
              and falls back to this one when that feed stops answering.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">
                One source per match
              </label>
              <Button
                variant="soft"
                size="sm"
                onClick={() => setRows((previous) => [...previous, newRow()])}
              >
                <Plus className="h-3.5 w-3.5" />
                Add a match
              </Button>
            </div>

            {rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-edge px-3 py-4 text-center text-[11px] text-ink-500">
                No match has a source of its own yet.
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <input
                      className={cn(field, 'w-2/5')}
                      value={row.key}
                      onChange={(event) =>
                        setRows((previous) =>
                          previous.map((entry) =>
                            entry.id === row.id ? { ...entry, key: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="match name"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <input
                      className={cn(field, 'flex-1')}
                      value={row.url}
                      onChange={(event) =>
                        setRows((previous) =>
                          previous.map((entry) =>
                            entry.id === row.id ? { ...entry, url: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="https://your-host/live/match/index.m3u8"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setRows((previous) => previous.filter((entry) => entry.id !== row.id))
                      }
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-edge text-ink-400 transition hover:border-edge-hi hover:text-flare"
                      aria-label="Remove this match"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-ink-500">
              The match name is the one in the app’s own address —{' '}
              <span className="font-mono text-ink-400">/watch?id=…</span>. A match with a source of
              its own is served from it alone.
            </p>
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">
                Referer (optional)
              </label>
              <input
                className={field}
                value={referer}
                onChange={(event) => setReferer(event.target.value)}
                placeholder="https://your-host/"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">
                Name (optional)
              </label>
              <input
                className={field}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="My own server"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </section>

          {data ? (
            <p className="break-all text-[10px] leading-relaxed text-ink-500">
              Kept in <span className="font-mono text-ink-400">{data.file}</span>
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-edge bg-void-800 px-4 py-3.5 sm:px-6">
          {message ? (
            <p
              className={cn(
                'min-w-0 flex-1 text-xs',
                message.kind === 'ok' ? 'text-volt' : 'text-flare',
              )}
            >
              {message.text}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-[11px] text-ink-500">
              Whatever you point it at, the app hosts it itself.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !data?.configured}
              onClick={() => void clear()}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove all
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
