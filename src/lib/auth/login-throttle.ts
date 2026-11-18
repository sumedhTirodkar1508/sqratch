import crypto from "crypto";
import { sharedRateLimit, sharedRateLimitReset } from "@/lib/rate-limit-shared";

/**
 * Attempts allowed per 15 minutes:
 *  - per account AND address: the tight limit that stops guessing from one place;
 *  - per account alone: a high ceiling for distributed guessing that cannot be used
 *    to lock a victim out from a single address (their own address is unaffected);
 *  - per address: guessing across many accounts.
 */
export const LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP = 10;
export const LOGIN_ATTEMPTS_PER_ACCOUNT = 100;
export const LOGIN_ATTEMPTS_PER_IP = 60;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * The client address for throttling. On Vercel it prefers the headers the platform
 * sets itself (`x-vercel-forwarded-for`, `x-real-ip`); otherwise the LAST
 * `x-forwarded-for` entry (added by the nearest proxy), since a client can prepend
 * entries to that header.
 */
export function clientIp(headers?: Record<string, unknown>) {
  const text = (name: string) => {
    const value = headers?.[name];
    return typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
  };
  // Platform-set headers are trustworthy only where the platform overwrites them (Vercel).
  // Anywhere else a client could rotate them, so only the last forwarded hop is used.
  if (process.env.VERCEL) {
    const platform = text("x-vercel-forwarded-for")[0] || text("x-real-ip")[0];
    if (platform) return platform;
  }
  return text("x-forwarded-for").at(-1) || "unknown";
}

/**
 * Throttle for credential sign-in. `beginAttempt` counts the attempt atomically
 * BEFORE the password is checked, so parallel guesses cannot all slip past a
 * check-then-record gap; it reports whether this attempt is over a limit. A
 * successful sign-in clears the account-and-address counter, so a person who
 * types the right password is never locked out by their own earlier slips.
 * Keys are hashed; no raw email is stored. Uses the shared store when
 * RATE_LIMIT_STORE=postgres, else per-instance memory.
 */
export function loginThrottle(headers?: Record<string, unknown>) {
  const ip = clientIp(headers);
  const accountHash = (email: string) => crypto.createHash("sha256").update(email).digest("hex");
  const pairKey = (email: string) => `login:pair:${accountHash(email)}:${ip}`;
  return {
    beginAttempt: async (email: string) => {
      // The tight pair and per-address counters are checked first. The per-account
      // ceiling only counts attempts that got past them, so one address hammering a
      // victim's email cannot run the shared counter up and lock the owner out.
      const [pair, address] = await Promise.all([
        sharedRateLimit(pairKey(email), LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP, LOGIN_WINDOW_MS),
        sharedRateLimit(`login:ip:${ip}`, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_MS),
      ]);
      if (!pair.success || !address.success) return true;
      const account = await sharedRateLimit(`login:acct:${accountHash(email)}`, LOGIN_ATTEMPTS_PER_ACCOUNT, LOGIN_WINDOW_MS);
      return !account.success;
    },
    recordSuccess: async (email: string) => {
      await sharedRateLimitReset(pairKey(email));
    },
  };
}
