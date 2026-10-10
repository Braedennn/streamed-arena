import WatchClient from './watch-client';

export function generateStaticParams() {
  return [{ id: 'index' }];
}

export default function WatchPage() {
  return <WatchClient />;
}
