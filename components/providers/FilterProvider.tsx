'use client';

import * as React from 'react';
import { useDebouncedValue } from '@/lib/hooks';

interface FilterContextValue {
  readonly rawQuery: string;
  readonly query: string;
  readonly setRawQuery: (value: string) => void;
  readonly sport: string;
  readonly setSport: (value: string) => void;
  readonly density: 'comfortable' | 'compact';
  readonly setDensity: (value: 'comfortable' | 'compact') => void;
}

const FilterContext = React.createContext<FilterContextValue | null>(null);

export function FilterProvider({ children }: { children: React.ReactNode }) {
  const [rawQuery, setRawQuery] = React.useState('');
  const [sport, setSport] = React.useState('all');
  const [density, setDensity] = React.useState<'comfortable' | 'compact'>('comfortable');
  const query = useDebouncedValue(rawQuery, 250);

  const value = React.useMemo(
    () => ({ rawQuery, query, setRawQuery, sport, setSport, density, setDensity }),
    [rawQuery, query, sport, density],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterContextValue {
  const context = React.useContext(FilterContext);
  if (!context) throw new Error('useFilters must be used inside FilterProvider');
  return context;
}
