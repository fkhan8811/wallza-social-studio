import { internalFetch } from '@gitroom/helpers/utils/internal.fetch';
import { Metadata } from 'next';
import { ReviewDecisionClient } from '@gitroom/frontend/components/reviews/review-decision.client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Content review',
  robots: { index: false, follow: false },
};

export default async function PublicReviewPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const response = await internalFetch(`/reviews/public/${encodeURIComponent(token)}`);
  if (!response.ok) {
    const message = response.status === 410
      ? 'This review link has expired.'
      : 'This review link is invalid or the posts are no longer available.';
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[900px] items-center justify-center p-[20px]">
        <div className="rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[24px] text-center text-[14px]">{message}</div>
      </main>
    );
  }

  const payload = await response.json();
  const review = payload.review;
  const posts = payload.posts || [];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1000px] flex-col gap-[18px] p-[20px] text-newTextColor">
      <header className="flex flex-col gap-[6px] border-b border-blockSeparator pb-[16px]">
        <p className="text-[11px] font-[700] uppercase tracking-[0.12em] text-textItemBlur">Wallza Social Studio</p>
        <h1 className="text-[24px] font-[750]">Content review</h1>
        <p className="text-[13px] text-textItemBlur">Review the proposed content for each connected channel. Your response will be recorded for the content team.</p>
        {review.reviewerName && <p className="text-[12px] text-textItemBlur">Prepared for {review.reviewerName}</p>}
        <p className="text-[11px] text-textItemBlur">Link expires {new Date(review.expiresAt).toLocaleString()}</p>
      </header>
      <section className="flex flex-col gap-[12px]">
        {posts.map((post: any) => (
          <article key={post.id} className="flex flex-col gap-[10px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <h2 className="text-[15px] font-[700]">{post.title || 'Social post'}</h2>
              <span className="rounded-full bg-newBgColor px-[9px] py-[4px] text-[11px] text-textItemBlur">{post.integration?.name || post.integration?.providerIdentifier || 'Channel'}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.7]">{post.content}</p>
            <p className="text-[11px] text-textItemBlur">Planned date: {new Date(post.publishDate).toLocaleString()}</p>
          </article>
        ))}
      </section>
      <ReviewDecisionClient token={token} initialStatus={review.status} initialComment={review.comment} />
      <footer className="text-center text-[10px] text-textItemBlur">This link is private to its recipient. Do not forward it to anyone else.</footer>
    </main>
  );
}
