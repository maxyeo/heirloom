import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_SITE_TITLE ?? "Heirloom",
  description: "A private family wiki and family tree.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-white text-stone-900 antialiased dark:bg-stone-900 dark:text-stone-100">
        {children}
      </body>
    </html>
  );
}
