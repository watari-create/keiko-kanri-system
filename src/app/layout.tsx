import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/AuthContext";

export const metadata: Metadata = {
  title: "稽古管理システム",
  description: "会員・出席・入金・許状の一元管理",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-bg text-ink min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
