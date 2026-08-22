import { auth } from "@/auth";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * The single boundary. Every route handler and server action that touches the
 * database goes through this — there is no row-level security underneath to
 * catch a route that forgets, because the app connects to Postgres as one
 * role rather than as the signed-in user.
 */
export async function requireSession() {
  const session = await auth();
  if (!session?.user?.email) throw new UnauthorizedError();
  return session;
}

/** Route-handler flavour: returns a 401 Response instead of throwing. */
export async function requireSessionOr401() {
  const session = await auth();
  if (!session?.user?.email) {
    return {
      session: null,
      response: new Response("Unauthorized", { status: 401 }),
    } as const;
  }
  return { session, response: null } as const;
}
