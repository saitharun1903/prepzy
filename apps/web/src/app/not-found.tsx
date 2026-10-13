import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="min-h-dvh flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-[13px] text-muted mb-2">404</p>
        <h1 className="serif text-4xl mb-3">Page not found</h1>
        <p className="text-ink-2 mb-6">This page does not exist, or it may have been deleted.</p>
        <Link href="/" className="text-accent underline underline-offset-4">Go to Home</Link>
      </div>
    </main>
  );
}
