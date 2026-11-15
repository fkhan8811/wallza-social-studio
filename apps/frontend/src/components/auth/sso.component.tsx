'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { sanitizeReturnUrl } from '@gitroom/helpers/utils/safe.return.url';
import Link from 'next/link';

export function SsoComponent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const fetchClient = useFetch();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const returnUrl = searchParams.get('returnUrl') || '/launches';

  useEffect(() => {
    let isSubscribed = true;

    async function exchange() {
      if (!code || !state) {
        if (isSubscribed) {
          setError('Missing SSO ticket parameters (code or state).');
          setLoading(false);
        }
        return;
      }

      try {
        const redirectUri = `${window.location.origin}/auth/sso`;
        const res = await fetchClient('/auth/sso/exchange', {
          method: 'POST',
          body: JSON.stringify({
            code,
            state,
            redirectUri,
            returnUrl,
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: 'SSO exchange failed' }));
          if (isSubscribed) {
            setError(errData.error || 'Authentication with WallzaOS failed.');
            setLoading(false);
          }
          return;
        }

        const data = await res.json();
        if (isSubscribed) {
          const rawDest = data.returnUrl || returnUrl || '/launches';
          const dest = sanitizeReturnUrl(rawDest, '/launches');
          window.location.href = dest;
        }
      } catch (err: any) {
        if (isSubscribed) {
          setError(err?.message || 'An unexpected error occurred during SSO authentication.');
          setLoading(false);
        }
      }
    }

    exchange();

    return () => {
      isSubscribed = false;
    };
  }, [code, state, returnUrl, fetchClient, router]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
        <h2 className="text-xl font-semibold mb-2">Authenticating with WallzaOS...</h2>
        <p className="text-sm text-gray-400">Verifying session ticket and establishing Social Studio access.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
      <div className="w-12 h-12 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center mb-4 text-2xl font-bold">
        !
      </div>
      <h2 className="text-xl font-semibold mb-2 text-red-400">Authentication Error</h2>
      <p className="text-sm text-gray-300 mb-6 bg-red-950/40 p-3 rounded border border-red-900/50">
        {error}
      </p>
      <Link
        href="/auth/login"
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium text-sm transition-colors"
      >
        Return to Login
      </Link>
    </div>
  );
}

