'use client';

import * as React from 'react';
import {
  Activity,
  Aperture,
  Car,
  Circle,
  CircleDot,
  Crosshair,
  Dumbbell,
  Flag,
  Goal,
  Layers,
  Medal,
  Orbit,
  Snowflake,
  Swords,
  Target,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Sport } from '@/lib/types';

const SPORT_ICONS: Record<string, LucideIcon> = {
  soccer: Goal,
  basketball: CircleDot,
  football: Crosshair,
  'american-football': Crosshair,
  hockey: Snowflake,
  baseball: Orbit,
  racing: Car,
  'motor-sports': Car,
  combat: Swords,
  fight: Swords,
  tennis: Circle,
  rugby: Dumbbell,
  golf: Flag,
  billiards: Aperture,
  afl: Medal,
  darts: Target,
  cricket: Activity,
  other: Layers,
};

export function sportIcon(category: string): LucideIcon {
  return SPORT_ICONS[category] ?? Trophy;
}

interface SportsShelfProps {
  sports: readonly Sport[];
  counts: Readonly<Record<string, number>>;
  active: string;
  onChange: (value: string) => void;
  total: number;
}

export function SportsShelf({ sports, counts, active, onChange, total }: SportsShelfProps) {
  const items = React.useMemo(() => {
    const visible = sports.filter(
      (sport) => (counts[sport.id] ?? 0) > 0 || sport.id === active,
    );
    if (visible.length > 0) return visible;
    return sports;
  }, [sports, counts, active]);

  return (
    <div className="-mx-4 overflow-x-auto px-4 no-scrollbar sm:-mx-6 sm:px-6">
      <div className="flex w-max items-center gap-2 pb-1">
        <ShelfChip
          active={active === 'all'}
          onClick={() => onChange('all')}
          icon={Trophy}
          label="All Sports"
          count={total}
        />
        {items.map((sport) => {
          const Icon = sportIcon(sport.id);
          return (
            <ShelfChip
              key={sport.id}
              active={active === sport.id}
              onClick={() => onChange(sport.id)}
              icon={Icon}
              label={sport.name}
              count={counts[sport.id] ?? 0}
            />
          );
        })}
      </div>
    </div>
  );
}

function ShelfChip({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative inline-flex items-center gap-2 whitespace-nowrap rounded-2xl border px-3.5 py-2.5 text-xs font-semibold transition-all duration-300 ease-out-expo active:scale-[0.97]',
        active
          ? 'border-volt bg-volt text-void'
          : 'border-edge bg-void-850 text-ink-300 hover:-translate-y-0.5 hover:border-edge-hi hover:bg-void-700 hover:text-white',
      )}
    >
      <Icon
        className={cn(
          'h-4 w-4 transition-colors',
          active ? 'text-void' : 'text-ink-400 group-hover:text-white',
        )}
      />
      {label}
      <span
        className={cn(
          'rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors',
          active ? 'bg-void-950 text-white' : 'bg-void-700 text-ink-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}
