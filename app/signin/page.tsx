import { signIn } from "@/auth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold">
          {process.env.NEXT_PUBLIC_SITE_TITLE ?? "Heirloom"}
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
          This site is private.
        </p>

        {error ? (
          <p className="mt-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
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
            className="w-full rounded-md border border-stone-300 px-4 py-2.5 text-sm font-medium transition hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
          >
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
