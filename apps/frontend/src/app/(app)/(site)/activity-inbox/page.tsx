import { ActivityInboxComponent } from '@gitroom/frontend/components/activity-inbox/activity-inbox.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Wallza'} Activity Inbox`,
  description: 'Publishing alerts, post discussions and client review activity.',
};

export default async function ActivityInboxPage() {
  return <ActivityInboxComponent />;
}
