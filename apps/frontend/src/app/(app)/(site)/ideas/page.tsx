import { IdeasComponent } from '@gitroom/frontend/components/ideas/ideas.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Wallza'} Ideas`,
  description: 'Organize content ideas and move them through your publishing workflow.',
};

export default async function IdeasPage() {
  return <IdeasComponent />;
}
