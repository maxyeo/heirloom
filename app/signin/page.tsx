import { signIn } from "@/auth";
import { siteName } from "@/lib/site";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <h1>{siteName()}</h1>
        <p className="text-caption text-ink-muted">This site is private.</p>

        {error ? (
          <p className="mt-6 rounded-panel border border-link-new bg-panel px-4 py-3 text-ink">
            That account does not have access.
          </p>
        ) : null}

        <form
          className="mt-8"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-panel border border-rule px-4 py-2.5 font-medium transition hover:bg-panel"
          >
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
