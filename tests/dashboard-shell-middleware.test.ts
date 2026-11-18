process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET = "test-dashboard-shell-middleware-secret";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { middleware } from "../src/middleware";

const SESSION_COOKIE = "next-auth.session-token";

async function sessionCookie() {
  // getToken() decodes with next-auth's default (empty) salt, so encode the same way.
  const value = await encode({
    token: { sub: "test-user", role: "USER" },
    secret: process.env.NEXTAUTH_SECRET as string,
  });
  return `${SESSION_COOKIE}=${value}`;
}

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

// NextResponse.next({ request: { headers } }) encodes forwarded request headers
// as "x-middleware-request-<name>" with the list in "x-middleware-override-headers".
function forwardedRequestHeader(response: Response, name: string) {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("middleware x-pathname forwarding", () => {
  test("forwards the pathname as a request header for an authenticated dashboard route", async () => {
    const cookie = await sessionCookie();
    const response = await middleware(
      request("/dashboard/brand/shopify/install?shop=example", cookie),
    );

    assert.equal(
      forwardedRequestHeader(response, "x-pathname"),
      "/dashboard/brand/shopify/install",
    );
    assert.match(
      response.headers.get("x-middleware-override-headers") ?? "",
      /\bx-pathname\b/,
    );
    assert.equal(response.headers.get("location"), null);
  });

  test("does not leave x-pathname on the response headers", async () => {
    const cookie = await sessionCookie();
    const response = await middleware(request("/dashboard/brand/profile", cookie));

    assert.equal(response.headers.get("x-pathname"), null);
  });

  test("overwrites a client-supplied x-pathname with the real path", async () => {
    const cookie = await sessionCookie();
    const spoofed = new NextRequest(
      "http://localhost:3000/dashboard/brand/profile",
      { headers: { cookie, "x-pathname": "/dashboard/brand/shopify/install" } },
    );
    const response = await middleware(spoofed);

    assert.equal(
      forwardedRequestHeader(response, "x-pathname"),
      "/dashboard/brand/profile",
    );
  });

  test("keeps the auth redirect for unauthenticated dashboard requests", async () => {
    const response = await middleware(request("/dashboard/brand/profile"));

    assert.equal(response.status, 307);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.pathname, "/login");
    assert.equal(
      location.searchParams.get("callbackUrl"),
      "/dashboard/brand/profile",
    );
    assert.equal(forwardedRequestHeader(response, "x-pathname"), null);
  });

  test("keeps the webhook early return without header forwarding", async () => {
    const response = await middleware(
      request("/api/shopify/webhooks/orders-create"),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-override-headers"), null);
    assert.equal(response.headers.get("x-pathname"), null);
  });
});
