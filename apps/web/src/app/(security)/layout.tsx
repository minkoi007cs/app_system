export const dynamic = 'force-dynamic';

export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-12">
      {children}
    </main>
  );
}
