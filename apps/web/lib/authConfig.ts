import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { isAllowedStaffEmail } from "./adminAuth";

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export function devAuthEnabled(source: AuthEnvironment = process.env): boolean {
  return source.NODE_ENV !== "production" && source.DEV_AUTH_ENABLED === "true";
}

function devAdminUser(source: AuthEnvironment) {
  if (!devAuthEnabled(source)) return null;
  const email = source.DEV_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !isAllowedStaffEmail(email, source.STAFF_EMAIL_ALLOWLIST)) return null;
  return { id: `dev:${email}`, email, name: "Local Admin" };
}

export function buildAuthConfig(source: AuthEnvironment = process.env): NextAuthConfig {
  return {
    providers: [
      Google,
      ...(devAuthEnabled(source)
        ? [Credentials({
            credentials: {},
            authorize() {
              return devAdminUser(source);
            },
          })]
        : []),
    ],
    pages: { signIn: "/admin/login" },
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    callbacks: {
      signIn({ user, profile, account }) {
        if (account?.provider === "credentials") {
          const expected = devAdminUser(source);
          return Boolean(expected && user.email?.toLowerCase() === expected.email);
        }
        const verified = profile && "email_verified" in profile
          ? profile.email_verified === true
          : false;
        return verified && isAllowedStaffEmail(user.email, source.STAFF_EMAIL_ALLOWLIST);
      },
      authorized({ auth: session, request }) {
        const path = request.nextUrl.pathname;
        if (path === "/admin/login") return true;
        if (path.startsWith("/admin")) {
          return isAllowedStaffEmail(session?.user?.email, source.STAFF_EMAIL_ALLOWLIST);
        }
        return true;
      },
    },
  };
}
