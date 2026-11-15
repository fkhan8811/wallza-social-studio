export const dynamic = 'force-dynamic';

import { SsoComponent } from '@gitroom/frontend/components/auth/sso.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} WallzaOS SSO`,
  description: 'Single Sign-On authentication via WallzaOS',
};

export default async function SsoPage() {
  return <SsoComponent />;
}

