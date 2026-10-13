import type { NextRequest } from "next/server";
import { publicAuth } from "../_shared";

export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  return publicAuth(req, "forgot-password", ["email"]);
}
