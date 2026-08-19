import { JsonRpcLineServer } from "./json-rpc-server.js";
import { PiAgentSessionFactory } from "./pi-session.js";

const server = new JsonRpcLineServer(new PiAgentSessionFactory(), process.stdout);

const stop = (): void => {
  process.stdin.destroy();
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await server.run(process.stdin);
} catch (error) {
  const message = error instanceof Error ? error.message : "Agent worker failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
