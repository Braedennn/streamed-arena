'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import WatchClient from './[id]/watch-client';

function WatchById() {
  const params = useSearchParams();
  return <WatchClient id={params.get('id') ?? ''} />;
}

export default function WatchPage() {
  return (
    <Suspense fallback={null}>
      <WatchById />
    </Suspense>
  );
}
