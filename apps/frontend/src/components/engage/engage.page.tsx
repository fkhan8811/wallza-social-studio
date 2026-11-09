'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

type EngageStatus = {
  configured: boolean;
  provider: string;
  workspaceName: string;
  host: string | null;
  note: string;
};

export const EngagePage = () => {
  const fetch = useFetch();
  const [status, setStatus] = useState<EngageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/engage/status');
      if (!response.ok) {
        throw new Error('Unable to load Engage integration status.');
      }
      setStatus((await response.json()) as EngageStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load Engage status.');
    } finally {
      setLoading(false);
    }
  }, [fetch]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const openInbox = async () => {
    setOpening(true);
    setError('');
    try {
      const response = await fetch('/engage/launch', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || typeof result.url !== 'string') {
        throw new Error(
          typeof result.message === 'string'
            ? result.message
            : 'Could not create a secure Chatwoot sign-in link.'
        );
      }
      window.location.assign(result.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the inbox.');
      setOpening(false);
    }
  };

  return (
    <main className="min-h-full w-full px-5 py-8 md:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-7">
        <header className="flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#8B94A7]">
            WALLZA SOCIAL STUDIO
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-newTextColor">
            Engage
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-[#9299A8]">
            A shared team inbox for customer conversations. Open the inbox without
            creating another login or changing your active Postiz organization.
          </p>
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-h-[280px] flex-col justify-between rounded-2xl border border-[#303644] bg-newBgColorInner p-6">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#263B36] text-[#83E2B2]">
                <svg viewBox="0 0 24 24" width="25" height="25" fill="none" aria-hidden="true">
                  <path
                    d="M8 10h8M8 14h5m-1 7-4.2-3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-4l-2 3Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <h2 className="text-lg font-semibold text-newTextColor">
                  {status?.workspaceName || 'Your organization inbox'}
                </h2>
                <p className="text-sm leading-6 text-[#9299A8]">
                  {loading
                    ? 'Checking the inbox connection…'
                    : status?.note ||
                      'Connect your self-hosted Chatwoot instance to enable the team inbox.'}
                </p>
                {status?.configured && status.host && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-[#9AA3B2]">
                    <span className="h-2 w-2 rounded-full bg-[#58C995]" />
                    Connected service: {status.host}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-8 flex flex-col items-start gap-3">
              <button
                type="button"
                onClick={openInbox}
                disabled={loading || opening || !status?.configured}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#D9F8E8] px-5 py-2.5 text-sm font-semibold text-[#14251D] transition hover:bg-[#BFF1D7] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {opening ? 'Opening secure inbox…' : 'Open Engage inbox'}
                <span aria-hidden="true">↗</span>
              </button>
              {!loading && !status?.configured && (
                <p className="max-w-lg text-xs leading-5 text-[#9299A8]">
                  An administrator must configure CHATWOOT_BASE_URL and
                  CHATWOOT_PLATFORM_API_TOKEN on the backend. The Platform API
                  token is never sent to the browser.
                </p>
              )}
            </div>
          </div>

          <aside className="rounded-2xl border border-[#303644] bg-newBgColorInner p-6">
            <h3 className="text-sm font-semibold text-newTextColor">
              Included through Chatwoot
            </h3>
            <ul className="mt-4 flex flex-col gap-3 text-sm leading-5 text-[#A4AAB6]">
              <li>Shared inbox and conversation history</li>
              <li>Assign conversations to agents and teams</li>
              <li>Labels, priorities, private notes and saved replies</li>
              <li>WhatsApp, Instagram, Facebook Messenger and other supported channels</li>
              <li>Automation rules and inbox reporting</li>
            </ul>
            <p className="mt-5 border-t border-[#303644] pt-4 text-xs leading-5 text-[#858D9C]">
              Powered by the self-hosted Chatwoot Community Edition. Social channel
              availability depends on the channels enabled in your Chatwoot server.
            </p>
          </aside>
        </section>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-[#8B4545] bg-[#3A2428] px-4 py-3 text-sm text-[#FFC1C1]"
          >
            {error}
          </div>
        )}

        <p className="text-xs leading-5 text-[#858D9C]">
          Your Postiz organization controls which Chatwoot account you enter. User
          access is provisioned through the Chatwoot Platform API and authenticated
          with single sign-on.
        </p>
      </div>
    </main>
  );
};
