import fs from "node:fs";
import net from "node:net";

const [operation, target] = process.argv.slice(2);

if (operation === "write") {
  fs.writeFileSync(target, "branchestra-probe", { flag: "wx" });
} else if (operation === "env") {
  const leaked = Object.keys(process.env).filter((key) =>
    /(?:API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|BEDROCK|VERTEX|FOUNDRY)/i.test(key)
  );
  if (leaked.length > 0) process.exitCode = 42;
} else if (operation === "connect") {
  const separator = target.lastIndexOf(":");
  const host = target.slice(0, separator);
  const port = Number(target.slice(separator + 1));
  const socket = net.connect(port, host, () => process.exit(43));
  socket.on("error", () => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
} else {
  process.exitCode = 64;
}
