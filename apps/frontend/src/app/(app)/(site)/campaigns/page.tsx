import { CampaignsComponent } from '@gitroom/frontend/components/campaigns/campaigns.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Wallza'} Campaigns`,
  description: 'Plan and organize social publishing campaigns.',
};

export default async function CampaignsPage() {
  return <CampaignsComponent />;
}
