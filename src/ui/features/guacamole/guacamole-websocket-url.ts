export function buildGuacamoleWebSocketBaseUrl({
  isDev,
  isElectronApp,
  isEmbeddedApp,
  configuredServerUrl,
  basePath,
  location,
}: {
  isDev: boolean;
  isElectronApp: boolean;
  isEmbeddedApp: boolean;
  configuredServerUrl?: string;
  basePath: string;
  location: Pick<Location, "protocol" | "host">;
}) {
  if (isDev) {
    // Route through Vite's dev proxy (same origin the page itself was
    // loaded over) instead of assuming direct access to this literal host's
    // port 30008 — a hardcoded "localhost" breaks whenever the page is
    // reached through an SSH tunnel or port-forward that only forwards the
    // Vite dev port itself.
    const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
    return `${wsProtocol}://${location.host}/__termix_api/30008`;
  }
  if (isElectronApp) {
    if (isEmbeddedApp || !configuredServerUrl) return "ws://127.0.0.1:30008";

    const wsProtocol = configuredServerUrl.startsWith("https://")
      ? "wss://"
      : "ws://";
    const wsHost = configuredServerUrl
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    return `${wsProtocol}${wsHost}/guacamole/websocket/`;
  }

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  return `${wsProtocol}://${location.host}${basePath}/guacamole/websocket/`;
}
