'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export function WallzaSso() {
  const router = useRouter();
  const fetchData = useFetch();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Verifying your WallzaOS session…');
  const [orgName, setOrgName] = useState('');
  const exchangeStarted = useRef(false);

  useEffect(() => {
    if (exchangeStarted.current) return;
    exchangeStarted.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const returnUrl = params.get('returnUrl') || '/launches';

    if (!code || !state) {
      setStatus('error');
      setMessage('Missing SSO authorization code or state parameter. Please launch Social Studio from WallzaOS.');
      return;
    }

    const redirectUri = `${window.location.origin}${window.location.pathname}`;

    const performExchange = async () => {
      try {
        setMessage('Establishing authenticated Social Studio workspace…');
        const res = await fetchData('/auth/wallza-sso/exchange', {
          method: 'POST',
          body: JSON.stringify({
            code,
            state,
            redirect_uri: redirectUri,
          }),
        });

        if (res.status !== 200 && res.status !== 201) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || errData.error || `SSO exchange failed with status ${res.status}`);
        }

        const data = await res.json();
        setStatus('success');
        setOrgName(data.organization?.name || 'Workspace');
        setMessage(`Signed in successfully to ${data.organization?.name || 'Workspace'}! Redirecting…`);

        // If NOT_SECURED is active and token is in response, set client cookies
        if (data.token) {
          document.cookie = `auth=${data.token}; path=/; max-age=2592000`;
        }
        if (data.organization?.id) {
          document.cookie = `showorg=${data.organization.id}; path=/; max-age=2592000`;
        }

        setTimeout(() => {
          window.location.href = returnUrl;
        }, 300);
      } catch (err: any) {
        setStatus('error');
        setMessage(err.message || 'Unable to complete WallzaOS SSO authentication.');
      }
    };

    performExchange();
  }, [router, fetchData]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] w-full p-6 text-center">
      <div className="max-w-md w-full bg-[#18181b] border border-border/80 rounded-2xl p-8 shadow-2xl backdrop-blur">
        {/* Brand Header */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 via-indigo-600 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-purple-500/30 font-bold text-lg">
            W
          </div>
          <div className="text-start">
            <h2 className="text-base font-bold text-foreground">Wallza Social Studio</h2>
            <p className="text-xs text-muted-foreground">Unified Authentication</p>
          </div>
        </div>

        {status === 'loading' && (
          <div className="flex flex-col items-center py-6">
            <div className="relative w-12 h-12 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-purple-500/20 animate-ping" />
              <div className="w-12 h-12 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            </div>
            <p className="text-sm text-foreground/90 font-medium">{message}</p>
            <p className="text-xs text-muted-foreground mt-1">Connecting to your WallzaOS organization</p>
          </div>
        )}

        {status === 'success' && (
          <div className="flex flex-col items-center py-6">
            <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-emerald-400">{message}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center py-6">
            <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-4">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h3 className="text-sm font-bold text-rose-400 mb-2">Authentication Failed</h3>
            <p className="text-xs text-muted-foreground mb-6 leading-relaxed">{message}</p>
            <button
              onClick={() => {
                const mainUrl = process.env.NEXT_PUBLIC_MAIN_URL || 'http://localhost:5001';
                window.location.href = `${mainUrl}/social-publisher`;
              }}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-700 text-white transition-all shadow-md shadow-purple-600/30"
            >
              Return to WallzaOS
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

