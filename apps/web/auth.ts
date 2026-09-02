import NextAuth, { type NextAuthResult } from "next-auth";
import { buildAuthConfig } from "@/lib/authConfig";

export { devAuthEnabled } from "@/lib/authConfig";

const nextAuth: NextAuthResult = NextAuth(buildAuthConfig());
export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
