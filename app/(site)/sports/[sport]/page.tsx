import SportChannel from './sport-client';

export function generateStaticParams() {
  return [{ sport: 'all' }];
}

export default function SportPage() {
  return <SportChannel />;
}
