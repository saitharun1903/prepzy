"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/primitives";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="max-w-lg">
      <h1 className="serif text-3xl mb-2">Something went wrong on this page</h1>
      <p className="text-ink-2 mb-1">The page hit an unexpected error. Your saved data is not affected.</p>
      {error.digest ? <p className="text-[13px] text-muted mb-4">Reference: <span className="font-mono">{error.digest}</span></p> : null}
      <Button variant="primary" onClick={reset}>Try again</Button>
    </div>
  );
}
