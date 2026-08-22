export { auth as proxy } from "@/auth";

/**
 * Everything is private by default. Only the sign-in page, Auth.js's own
 * endpoints, and static assets are reachable logged out — so a new route is
 * protected the moment it exists, rather than whenever someone remembers to
 * guard it.
 */
export const config = {
  matcher: [
    "/((?!api/auth|signin|_next/static|_next/image|favicon.ico|.*\\.svg$).*)",
  ],
};
