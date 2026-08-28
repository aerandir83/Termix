import { describe, it, expect } from "vitest";
import { buildGuacamoleWebSocketBaseUrl } from "@/features/guacamole/guacamole-websocket-url.ts";

describe("buildGuacamoleWebSocketBaseUrl", () => {
  it("routes dev mode through the same-origin Vite proxy, not a hardcoded host", () => {
    const url = buildGuacamoleWebSocketBaseUrl({
      isDev: true,
      isElectronApp: false,
      isEmbeddedApp: false,
      basePath: "",
      location: { protocol: "http:", host: "localhost:5173" },
    });
    // Must stay same-origin as the page (works through SSH tunnels/port
    // forwards that only forward the Vite dev port) instead of assuming
    // direct access to this literal host's port 30008.
    expect(url).toBe("ws://localhost:5173/__termix_api/30008");
  });

  it("uses wss when the page itself was loaded over https in dev mode", () => {
    const url = buildGuacamoleWebSocketBaseUrl({
      isDev: true,
      isElectronApp: false,
      isEmbeddedApp: false,
      basePath: "",
      location: { protocol: "https:", host: "example.dev:5173" },
    });
    expect(url).toBe("wss://example.dev:5173/__termix_api/30008");
  });
});
