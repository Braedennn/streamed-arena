'use client';

import * as React from 'react';
import type HlsType from 'hls.js';
import {
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Level {
  height: number;
  bitrate: number;
}

interface HlsPlayerProps {
  src: string;
  poster?: string | null;
  onError?: (message: string) => void;
}

export function HlsPlayer({ src, poster, onError }: HlsPlayerProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const hlsRef = React.useRef<HlsType | null>(null);

  const [status, setStatus] = React.useState<'loading' | 'playing' | 'paused' | 'error'>('loading');
  const [error, setError] = React.useState<string | null>(null);
  const [levels, setLevels] = React.useState<Level[]>([]);
  const [levelIndex, setLevelIndex] = React.useState(-1);
  const [muted, setMuted] = React.useState(false);
  const [volume, setVolume] = React.useState(1);
  const [live, setLive] = React.useState(true);
  const [duration, setDuration] = React.useState(0);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const onErrorRef = React.useRef(onError);

  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  React.useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const video = videoRef.current;
      if (!video) return;

      setStatus('loading');
      setError(null);
      setLevels([]);
      setLevelIndex(-1);

      const module = await import('hls.js');
      if (cancelled) return;
      const Hls = module.default;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 24,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 6,
          capLevelToPlayerSize: true,
          abrEwmaDefaultEstimate: 1_000_000,
          progressive: false,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          if (cancelled) return;
          setLevels(data.levels.map((level) => ({ height: level.height, bitrate: level.bitrate })));
          setStatus('paused');
          void video.play().catch(() => undefined);
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          if (cancelled) return;
          setLevelIndex(hls.autoLevelEnabled ? -1 : data.level);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          hls.destroy();
          const message = 'HLS playback failed — source may be offline.';
          setError(message);
          setStatus('error');
          onErrorRef.current?.(message);
        });

        hls.loadSource(src);
        hls.attachMedia(video);
        return;
      }

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        return;
      }

      setError('This browser cannot decode HLS streams.');
      setStatus('error');
      onErrorRef.current?.('This browser cannot decode HLS streams.');
    };

    void boot();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src, attempt]);

  React.useEffect(() => {
    const onFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const togglePlay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const selectLevel = React.useCallback((index: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = index;
    setLevelIndex(index);
    setMenuOpen(false);
  }, []);

  const toggleFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  }, []);

  const togglePip = React.useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      setError(null);
    }
  }, []);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : live ? 100 : 0;

  return (
    <div ref={containerRef} className="group/player relative h-full w-full bg-black">
      <video
        ref={videoRef}
        poster={poster ?? undefined}
        playsInline
        autoPlay
        className="h-full w-full bg-black object-contain"
        onClick={togglePlay}
        onPlay={() => setStatus('playing')}
        onPause={() => setStatus('paused')}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          setCurrentTime(video.currentTime);
          if (Number.isFinite(video.duration)) {
            setDuration(video.duration);
            setLive(video.duration === Infinity);
          }
        }}
      />

      {status === 'loading' ? (
        <div className="absolute inset-0 grid place-items-center bg-void-950">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-7 w-7 animate-spin text-live-400" />
            <p className="text-xs uppercase tracking-[0.24em] text-ink-400">Locking feed</p>
          </div>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="absolute inset-0 grid place-items-center bg-void-950 px-6 text-center">
          <div className="space-y-3">
            <p className="text-sm text-flare">{error ?? 'Stream unavailable'}</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="inline-flex items-center gap-2 rounded-xl border border-edge px-4 py-2 text-xs text-white transition hover:border-edge-hi"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry feed
            </button>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 translate-y-1 border-t border-edge bg-void-950 p-3 opacity-0 transition-all duration-300 group-hover/player:translate-y-0 group-hover/player:opacity-100 focus-within:translate-y-0 focus-within:opacity-100">
        <div className="pointer-events-auto space-y-2">
          <div className="relative h-1.5 w-full cursor-pointer rounded-full bg-void-700">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-live"
              style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlay}
              className="grid h-9 w-9 place-items-center rounded-lg bg-void-800 text-white transition hover:bg-void-700"
              aria-label={status === 'playing' ? 'Pause' : 'Play'}
            >
              {status === 'playing' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                const next = !muted;
                setMuted(next);
                video.muted = next;
              }}
              className="grid h-9 w-9 place-items-center rounded-lg bg-void-800 text-white transition hover:bg-void-700"
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>

            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => {
                const value = Number(event.target.value);
                setVolume(value);
                setMuted(value === 0);
                if (videoRef.current) {
                  videoRef.current.volume = value;
                  videoRef.current.muted = value === 0;
                }
              }}
              className="h-1 w-20 cursor-pointer accent-live-500"
              aria-label="Volume"
            />

            <span className="ml-1 font-mono text-[11px] tabular-nums text-ink-200">
              {live ? 'LIVE EDGE' : formatTime(currentTime)}
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <span className="hidden rounded-md border border-live bg-live px-2 py-1 text-[9px] font-bold uppercase tracking-[0.16em] text-void sm:inline">
                HLS · ABR
              </span>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((value) => !value)}
                  className="grid h-9 w-9 place-items-center rounded-lg bg-void-800 text-white transition hover:bg-void-700"
                  aria-label="Quality"
                >
                  <Settings2 className="h-4 w-4" />
                </button>
                {menuOpen ? (
                  <div className="absolute bottom-11 right-0 z-20 w-44 overflow-hidden rounded-xl border border-edge bg-void-950 p-1.5">
                    <QualityOption
                      active={levelIndex === -1}
                      label="Auto"
                      onClick={() => selectLevel(-1)}
                    />
                    {levels.map((level, index) => (
                      <QualityOption
                        key={`${level.height}-${index}`}
                        active={levelIndex === index}
                        label={`${level.height}p`}
                        hint={`${Math.round(level.bitrate / 1000)} kbps`}
                        onClick={() => selectLevel(index)}
                      />
                    ))}
                    {levels.length === 0 ? (
                      <p className="px-2 py-3 text-center text-[10px] uppercase tracking-[0.14em] text-ink-500">
                        Detecting levels
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => void togglePip()}
                className="hidden h-9 w-9 place-items-center rounded-lg bg-void-800 text-white transition hover:bg-void-700 sm:grid"
                aria-label="Picture in picture"
              >
                <PictureInPicture2 className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="grid h-9 w-9 place-items-center rounded-lg bg-void-800 text-white transition hover:bg-void-700"
                aria-label="Fullscreen"
              >
                {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {status !== 'playing' && status !== 'error' ? (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 z-20 grid place-items-center"
          aria-label="Play"
        >
          <span className="grid h-16 w-16 place-items-center rounded-md border border-live bg-live text-void transition-transform duration-300 hover:scale-105">
            <Play className="h-6 w-6 translate-x-0.5" fill="currentColor" />
          </span>
        </button>
      ) : null}
    </div>
  );
}

function QualityOption({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
        active ? 'bg-void-700 text-live' : 'text-ink-300 hover:bg-void-800 hover:text-white',
      )}
    >
      {label}
      {hint ? <span className="font-mono text-[10px] text-ink-500">{hint}</span> : null}
    </button>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}
