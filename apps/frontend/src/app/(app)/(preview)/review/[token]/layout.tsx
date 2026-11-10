import { ReactNode } from 'react';
import { PreviewWrapper } from '@gitroom/frontend/components/preview/preview.wrapper';

export default async function PublicReviewLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-newBgColor text-newTextColor">
      <PreviewWrapper>{children}</PreviewWrapper>
    </div>
  );
}
