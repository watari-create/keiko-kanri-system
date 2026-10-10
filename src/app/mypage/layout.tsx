export default function MyPageLayout({ children }: { children: React.ReactNode }) {
  // 会員向け画面の配色（globals.css の .member-theme）
  return <div className="member-theme min-h-screen bg-bg text-ink">{children}</div>;
}
