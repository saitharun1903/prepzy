import type { NextRequest } from "next/server";
import { authenticate } from "../_shared";

export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  return authenticate(req, "register");
}
