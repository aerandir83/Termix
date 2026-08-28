import { describe, expect, it } from "vitest";
import { buildGuacamoleWebSocketBaseUrl } from "../../../features/guacamole/guacamole-websocket-url.js";

const httpsLocation = {
  protocol: "https:",
  host: "termix.example.com",
} as Location;

describe("buildGuacamoleWebSocketBaseUrl", () => {
  it("uses the same origin guacamole websocket path in production web builds", () => {
    expect(
      buildGuacamoleWebSocketBaseUrl({
        isDev: false,
        isElectronApp: false,
        isEmbeddedApp: false,
        basePath: "",
        location: httpsLocation,
      }),
    ).toBe("wss://termix.example.com/guacamole/websocket/");
  });

  it("preserves the runtime base path for proxied web deployments", () => {
    expect(
      buildGuacamoleWebSocketBaseUrl({
        isDev: false,
        isElectronApp: false,
        isEmbeddedApp: false,
        basePath: "/termix",
        location: httpsLocation,
      }),
    ).toBe("wss://termix.example.com/termix/guacamole/websocket/");
  });

  it("routes dev mode through the same-origin Vite proxy, and keeps direct local access for embedded electron", () => {
    // A hardcoded "localhost" breaks whenever the page is reached through
    // an SSH tunnel or port-forward that only forwards the Vite dev port --
    // the WS request must stay same-origin as the page itself.
    expect(
      buildGuacamoleWebSocketBaseUrl({
        isDev: true,
        isElectronApp: false,
        isEmbeddedApp: false,
        basePath: "/termix",
        location: httpsLocation,
      }),
    ).toBe("wss://termix.example.com/__termix_api/30008");

    expect(
      buildGuacamoleWebSocketBaseUrl({
        isDev: false,
        isElectronApp: true,
        isEmbeddedApp: true,
        basePath: "/termix",
        location: httpsLocation,
      }),
    ).toBe("ws://127.0.0.1:30008");
  });

  it("uses the configured remote server URL for electron remote mode", () => {
    expect(
      buildGuacamoleWebSocketBaseUrl({
        isDev: false,
        isElectronApp: true,
        isEmbeddedApp: false,
        configuredServerUrl: "https://termix.example.com/termix/",
        basePath: "",
        location: httpsLocation,
      }),
    ).toBe("wss://termix.example.com/termix/guacamole/websocket/");
  });
});
