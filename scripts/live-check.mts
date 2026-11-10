// Prints what discovery really finds on this machine, without revealing addresses:
//   npm run live-check
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../core/config.js";
import { tailscaleCliCandidates, type ExecFn } from "../core/discovery.js";
import { scanAll } from "../core/scan.js";

const run = promisify(execFile);
const exec: ExecFn = async (cmd, args) => {
  const { stdout } = await run(cmd, args, { timeout: 5000, windowsHide: true });
  return { stdout: String(stdout) };
};

const config = loadConfig();
console.log(`platform=${process.platform} node=${process.version}`);
console.log(
  `config: extraHosts=${config.extraHosts.length} lan=${config.enableLanScan} tailscale=${config.enableTailscale}`,
);

for (const cmd of tailscaleCliCandidates()) {
  try {
    const { stdout } = await exec(cmd, ["status", "--json"]);
    const peers = Object.values((JSON.parse(stdout) as { Peer?: Record<string, { Online?: boolean }> }).Peer ?? {});
    console.log(`tailscale CLI: OK via "${cmd}" (${peers.filter((p) => p.Online).length} of ${peers.length} peers online)`);
    break;
  } catch (error) {
    console.log(`tailscale CLI: not usable via "${cmd}" (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

const started = Date.now();
const { found, scannedHosts, warnings } = await scanAll({ config, exec, hostNames: new Map() });
console.log(`scan: ${Date.now() - started} ms, ${scannedHosts} host(s) scanned, ${found.size} server(s) found`);

for (const { server, models } of found.values()) {
  const name = server.hostName ? ` "${server.hostName}"` : "";
  console.log(`- ${server.label}${name} :${server.port} [${server.source}] ${models.length} model(s)`);
  for (const m of models.slice(0, 5)) {
    const input = m.vision ? "text+image" : "text";
    console.log(
      `    ${m.id.slice(0, 48).padEnd(48)} ctx=${String(m.contextWindow).padStart(7)} (${m.contextSource}) max=${m.maxTokens} ${input}${m.reasoning ? " reasoning" : ""}`,
    );
  }
  if (models.length > 5) console.log(`    ... ${models.length - 5} more`);
}
for (const w of warnings) console.log(`warning: ${w}`);
