'use client';

import * as React from 'react';
import { Check, Loader2, RadioTower, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  matchSource,
  readPersonalSources,
  writePersonalSources,
  type PersonalSources,
} from '@/lib/personal-sources';

// A source of the user's own, for this one match.
//
// The app hosts the stream itself either way. This is the switch that says
// where the bytes come from: with a source of your own set for a match, the
// app fetches that and serves it from its own disk, and it does not look the
// match up anywhere else.

interface MatchSourceControlProps {
  /** The match's stream key. */
  readonly streamKey: string;
  /** Called after the source changed, so the page can pick it up. */
  readonly onChanged: () => void;
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

export function MatchSourceControl({ streamKey, onChanged }: MatchSourceControlProps) {
  const [sources, setSources] = React.useState<PersonalSources | null>(null);
  const [url, setUrl] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [editing, setEditing] = React.useState(false);

  const load = React.useCallback(async () => {
    const data = await readPersonalSources();
    setSources(data);
    setUrl(matchSource(data, streamKey)?.url ?? '');
  }, [streamKey]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const current = matchSource(sources, streamKey);

  const save = React.useCallback(async () => {
    if (!isManifestUrl(url)) {
      setMessage({ kind: 'err', text: 'That is not a manifest URL.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const matches = (sources?.matches ?? [])
      .filter((entry) => entry.key !== streamKey)
      .map((entry) => ({ key: entry.key, url: entry.url }));
    matches.push({ key: streamKey, url: url.trim() });
    const saved = await writePersonalSources({
      default: sources?.default ?? null,
      matches,
      referer: sources?.referer ?? null,
      label: sources?.label ?? null,
    });
    setBusy(false);
    if (!saved) {
      setMessage({ kind: 'err', text: 'The source could not be saved.' });
      return;
    }
    setSources(saved);
    setEditing(false);
    setMessage({
      kind: 'ok',
      text:
        saved.origin === 'env'
          ? 'Saved — but the environment carries a source of its own, and that one wins.'
          : 'The app hosts your own source for this match now.',
    });
    onChanged();
  }, [url, sources, streamKey, onChanged]);

  const remove = React.useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const matches = (sources?.matches ?? [])
      .filter((entry) => entry.key !== streamKey)
      .map((entry) => ({ key: entry.key, url: entry.url }));
    const saved = await writePersonalSources({
      default: sources?.default ?? null,
      matches,
      referer: sources?.referer ?? null,
      label: sources?.label ?? null,
    });
    setBusy(false);
    if (!saved) {
      setMessage({ kind: 'err', text: 'The source could not be removed.' });
      return;
    }
    setSources(saved);
    setUrl('');
    setEditing(false);
    setMessage({
      kind: 'ok',
      text: saved.configured
        ? 'The source of yours for this match is gone — the environment still carries one.'
        : 'Removed — the app is back to the feed it can find.',
    });
    onChanged();
  }, [sources, streamKey, onChanged]);

  return (
    <div className="mt-4 border-t border-edge pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-ink-500">
          <RadioTower className="h-3 w-3" />
          Your own source
        </p>
        {current && !editing ? (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-ink-500 transition hover:text-flare disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            Remove
          </button>
        ) : null}
      </div>

      {current && !editing ? (
        <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-volt">
          {current.url}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <input
            className="h-9 w-full rounded-md border border-edge bg-void-950 px-2.5 font-mono text-[11px] text-white placeholder:text-ink-500 focus:border-edge-hi focus:outline-none"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://your-host/live/index.m3u8"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex items-center gap-2">
            <Button variant="soft" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {current ? 'Replace' : 'Use it'}
            </Button>
            {current ? (
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {message ? (
        <p
          className={cn(
            'mt-2 text-[11px] leading-relaxed',
            message.kind === 'ok' ? 'text-volt' : 'text-flare',
          )}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
