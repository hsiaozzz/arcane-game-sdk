import { readFile, writeFile } from "node:fs/promises";
const sql = await readFile(new URL("migrations/001_platform.sql", import.meta.url), "utf8");
const template = await readFile(new URL("runtime.template.js", import.meta.url), "utf8");
const source = template.replace('"__ARCANE_MIGRATION__"', () => JSON.stringify(sql));
await writeFile(new URL("runtime/index.js", import.meta.url), source);
console.log("Built ES5 Nakama runtime with schema 1");
