'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Radio, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UpdaterPayload {
  tag: string;
  mode: 'update' | 'rollback';
  /**
   * 'downloading' — the release was just found and is being fetched right
   * now; 'ready' — the installer is on disk and can be installed.
   */
  phase?: 'downloading' | 'ready';
}

interface ArenaUpdater {
  state: () => Promise<UpdaterPayload | null>;
  restart: () => void;
  onUpdate: (listener: (payload: UpdaterPayload) => void) => () => void;
}

function arenaUpdater(): ArenaUpdater | null {
  return (window as unknown as { arenaUpdater?: ArenaUpdater }).arenaUpdater ?? null;
}

// The desktop update popup. When a verified release has downloaded, the main
// process pushes 'arena-updater-ready' and this slides in from the corner —
// themed, quiet and dismissible, because some people update on their own
// schedule. Dismissed popups return on the next launch, and the update stays
// reachable from the Streamed Arena menu in the meantime. Browsers and the
// iOS app have no bridge and render nothing.
export function UpdatePopup() {
  const [payload, setPayload] = React.useState<UpdaterPayload | null>(null);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    const bridge = arenaUpdater();
    if (!bridge) return;
    void bridge
      .state()
      .then(setPayload)
      .catch(() => {});
    return bridge.onUpdate((next) => {
      setPayload(next);
      setDismissed(false);
    });
  }, []);

  const visible = payload !== null && !dismissed;
  const rollback = payload?.mode === 'rollback';
  const downloading = payload?.phase === 'downloading';

  return (
    <AnimatePresence>
      {visible && payload !== null && (
        <motion.div
          key={`${payload.mode}:${payload.tag}`}
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-4 right-4 z-50 w-[340px] max-w-[calc(100vw-2rem)] rounded-lg border border-edge-hi bg-void-850 p-4 shadow-2xl shadow-black/60"
          role="dialog"
          aria-label="Update available"
        >
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-volt text-void">
              <Radio size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-volt animate-pulse-live" />
                <p className="truncate font-display text-sm font-bold text-white">
                  {rollback
                    ? `Rolling back to ${payload.tag}`
                    : downloading
                      ? `Downloading ${payload.tag}`
                      : `${payload.tag} is ready`}
                </p>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-ink-300">
                {rollback
                  ? 'The previous version downloaded in the background. Restart to finish the rollback.'
                  : downloading
                    ? 'A new version just came out and is downloading in the background. We will tell you the moment it is ready to install.'
                    : 'The new version downloaded in the background. Update now or whenever suits you — it stays in the Streamed Arena menu.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="-m-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-400 transition hover:bg-void-800 hover:text-white"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 pl-12">
            {downloading ? (
              // Nothing to install yet — the installer is still coming down.
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-volt">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Downloading
              </span>
            ) : (
              <Button variant="primary" size="sm" onClick={() => arenaUpdater()?.restart()}>
                {rollback ? 'Restart to roll back' : 'Restart to update'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
              {downloading ? 'Hide' : 'Not now'}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
