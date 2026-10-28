// POST /functions/v1/user-settings — see handler.ts.
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req));
