import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Budget Intelligence",
  description: "Personal budget intelligence and financial coaching dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
