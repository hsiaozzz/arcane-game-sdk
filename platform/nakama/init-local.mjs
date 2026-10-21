import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const key = () => randomBytes(32).toString("hex");
const contents = ["POSTGRES_PASSWORD", "NAKAMA_SERVER_KEY", "NAKAMA_HTTP_KEY", "NAKAMA_SESSION_KEY", "NAKAMA_REFRESH_KEY", "NAKAMA_CONSOLE_PASSWORD", "ARCANE_GATEWAY_KEY", "ARCANE_ADMIN_KEY"].map((name) => `${name}=${key()}`).concat("ARCANE_ADAPTER_IDS=turn-based-v1,score-race-v1", "NAKAMA_API_PORT=7354", "NAKAMA_CONSOLE_PORT=7355", "").join("\n");
try { await writeFile(new URL(".env", import.meta.url), contents, { flag: "wx", mode: 0o600 }); console.log("Created ignored local credentials; values were not printed."); }
catch (error) { if (error.code !== "EEXIST") throw error; console.log("Existing .env preserved."); }
