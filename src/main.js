// Passbook entry point.
// Imports the legacy monolithic app and calls its boot function.
// Phase 1+ will extract pure functions and wire them here instead of
// using the legacy-app all at once.

import { boot } from "./legacy-app.js";

boot();
