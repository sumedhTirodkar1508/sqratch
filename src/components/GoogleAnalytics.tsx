"use client";
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { googleRouteKey } from '@/lib/analytics-policy';
import { gaEvent, resetGooglePage } from '@/lib/googleAnalytics';

export default function GoogleAnalytics() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || !googleRouteKey(window.location.href)) { resetGooglePage(); return; }
    gaEvent('page_view');
  }, [pathname]);
  return null;
}
