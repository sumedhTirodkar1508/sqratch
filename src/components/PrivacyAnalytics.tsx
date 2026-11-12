"use client";
import { usePathname } from 'next/navigation';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { analyticsPath, filterTelemetry, filterSpeedTelemetry } from '@/lib/analytics-policy';
export function PrivacyAnalytics() {
  const path = usePathname();
  if (!path || !analyticsPath(path)) return null;
  return <><Analytics debug={false} beforeSend={(event) => filterTelemetry(event, window.location.href, document.referrer)} /><SpeedInsights debug={false} beforeSend={(event) => filterSpeedTelemetry(event, window.location.href, document.referrer)} /></>;
}
