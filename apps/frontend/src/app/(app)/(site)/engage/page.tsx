import { Metadata } from 'next';
import { EngagePage } from '@gitroom/frontend/components/engage/engage.page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Wallza Engage',
  description: 'Team social conversations and customer messages.',
};

export default function Page() {
  return <EngagePage />;
}
