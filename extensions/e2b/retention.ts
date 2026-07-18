#!/usr/bin/env node
import { retainJobs } from "./jobs.js";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
	if (arg !== "--apply" && arg !== "--delete-archived") {
		console.error("usage: npm run jobs:retain -- [--apply] [--delete-archived]");
		process.exit(2);
	}
}
if (args.has("--delete-archived") && !args.has("--apply")) {
	console.error("--delete-archived requires --apply");
	process.exit(2);
}
const result = await retainJobs({
	apply: args.has("--apply"),
	deleteArchived: args.has("--delete-archived"),
});
console.log(`${args.has("--apply") ? "apply" : "dry-run"}: archive=${result.archive.length} delete=${result.delete.length}`);
