/**
 * Optional modules. Each import registers its tools (via server.ts toolGroups),
 * provider factories (providers/registry.ts) and CLI commands (index.ts extraCommands).
 * Keep one line per module so features can be added independently.
 */
import "./providers/imap.js";
import "./cli/imap.js";
