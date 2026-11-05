// An API route: GET /api/time
import { json } from "@sveltejs/kit";

export function GET() {
  return json({ time: new Date().toISOString() });
}
