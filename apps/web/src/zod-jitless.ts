import { z } from "zod";

// Zod's default JIT compiler uses `new Function`, which the viewer's CSP forbids.
z.config({ jitless: true });
