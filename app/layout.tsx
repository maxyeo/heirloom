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
      {/* Surface, ink and type all come from the theme tokens in
          globals.css, so nothing is set here. */}
      <body className="antialiased">{children}</body>
    </html>
  );
}
