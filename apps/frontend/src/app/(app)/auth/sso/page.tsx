export const dynamic = 'force-dynamic';
import { WallzaSso } from '@gitroom/frontend/components/auth/wallza-sso.component';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WallzaOS Single Sign-On | Social Studio',
  description: 'Authenticating your WallzaOS session for Social Studio',
};

export default function WallzaSsoPage() {
  return <WallzaSso />;
}

