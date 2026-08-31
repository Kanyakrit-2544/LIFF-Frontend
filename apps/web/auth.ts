import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedStaffEmail } from "@/lib/adminAuth";

const config: NextAuthConfig = {
  providers: [Google],
  pages: { signIn: "/admin/login" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    signIn({ user, profile }) {
      const verified = profile && "email_verified" in profile
        ? profile.email_verified === true
        : false;
      return verified && isAllowedStaffEmail(user.email);
    },
    authorized({ auth: session, request }) {
      const path = request.nextUrl.pathname;
      if (path === "/admin/login") return true;
      if (path.startsWith("/admin")) return isAllowedStaffEmail(session?.user?.email);
      return true;
    },
  },
};

const nextAuth: NextAuthResult = NextAuth(config);
export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
