import type { NextRequest } from "next/server";
import { completeMfa } from "../../_shared";

export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  return completeMfa(req);
}
