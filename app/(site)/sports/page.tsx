'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import SportChannel from './[sport]/sport-client';

function SportByParam() {
  const params = useSearchParams();
  return <SportChannel sport={params.get('sport') ?? 'all'} />;
}

export default function SportsPage() {
  return (
    <Suspense fallback={null}>
      <SportByParam />
    </Suspense>
  );
}
