import { ReviewsComponent } from '@gitroom/frontend/components/reviews/reviews.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Wallza'} Reviews`,
  description: 'Request and manage external social post approvals.',
};

export default async function ReviewsPage() {
  return <ReviewsComponent />;
}
