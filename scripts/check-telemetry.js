import { AppServerClient } from "../src/app-server-client.js";

const timeout = setTimeout(() => {
  console.error("Telemetry check timed out");
  process.exit(1);
}, 20_000);

const client = new AppServerClient({
  onStatus(status) {
    if (["error", "disconnected"].includes(status.state)) console.error(status.message);
  },
});

try {
  await client.start();
  const snapshot = await client.refresh();
  console.log(JSON.stringify(snapshot, null, 2));
  clearTimeout(timeout);
  client.stop();
} catch (error) {
  clearTimeout(timeout);
  client.stop();
  console.error(error);
  process.exit(1);
}
