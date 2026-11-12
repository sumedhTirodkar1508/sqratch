import type { Metadata } from "next";
import { Geist, Geist_Mono, Lexend_Giga, Montserrat } from "next/font/google";
import { PrivacyAnalytics } from "@/components/PrivacyAnalytics";
import "./globals.css";
import AuthProvider from "@/context/AuthProvider";
import GoogleAnalytics from "@/components/GoogleAnalytics";
import { Suspense } from "react";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const lexendGiga = Lexend_Giga({
  variable: "--font-lexend-giga",
  subsets: ["latin"],
  weight: ["700"],
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    default: "SQRATCH",
    template: "%s — SQRATCH",
  },
  description:
    "SQRATCH empowers brands and builders to create private, real-person communities.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {

  const isProd = process.env.NODE_ENV === "production";

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${lexendGiga.variable} ${montserrat.variable} font-sans antialiased app-bg`}
      >
        <ThemeProvider>
          <AuthProvider>
            {isProd && (
              <Suspense fallback={null}>
                <GoogleAnalytics />
              </Suspense>
            )}
            {children}
            <Suspense fallback={null}><PrivacyAnalytics /></Suspense>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
