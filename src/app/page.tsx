"use client";

export const dynamic = "force-dynamic";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthContext";

export default function RootPage() {
  const { role, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (role === "honbu") router.replace("/admin");
    else if (role === "staff") router.replace("/staff");
    else if (role === "member") router.replace("/mypage");
    else router.replace("/login");
  }, [role, loading, router]);

  return <div className="p-8 text-muted">読み込み中…</div>;
}
