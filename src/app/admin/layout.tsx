import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "顧客会員管理システム",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
