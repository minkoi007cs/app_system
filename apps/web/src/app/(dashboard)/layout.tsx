import Link from 'next/link';
import { Activity, Boxes, ScrollText } from 'lucide-react';
import { requireSuperAdmin } from '@/lib/admin';
import { SignOutButton } from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/apps', label: 'Applications', icon: Boxes },
  { href: '/health', label: 'Health', icon: Activity },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
] as const;

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireSuperAdmin();

  return (
    <div className="flex min-h-screen">
      <aside className="bg-muted/30 hidden w-60 shrink-0 flex-col border-r p-4 sm:flex">
        <div className="mb-6">
          <p className="text-sm font-semibold">Unified-App-Infra</p>
          <p className="text-muted-foreground truncate text-xs">{admin.email}</p>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide">{admin.role}</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm"
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <SignOutButton />
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
