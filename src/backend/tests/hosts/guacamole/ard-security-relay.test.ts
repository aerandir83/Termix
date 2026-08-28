import { describe, it, expect, vi, afterEach } from "vitest";
import net from "net";
import { startArdSecurityRelay } from "../../../hosts/guacamole/ard-security-relay.js";

describe("startArdSecurityRelay", () => {
  let fakeHost: net.Server | null = null;
  let relayClose: (() => void) | null = null;

  afterEach(() => {
    relayClose?.();
    relayClose = null;
    fakeHost?.close();
    fakeHost = null;
    vi.restoreAllMocks();
  });

  it("disables Nagle's algorithm on both relayed TCP legs", async () => {
    fakeHost = net.createServer((sock) => {
      sock.on("data", () => {});
    });
    await new Promise<void>((resolve) =>
      fakeHost!.listen(0, "127.0.0.1", () => resolve()),
    );
    const fakeHostPort = (fakeHost.address() as net.AddressInfo).port;

    const setNoDelaySpy = vi.spyOn(net.Socket.prototype, "setNoDelay");

    const relay = await startArdSecurityRelay(
      "127.0.0.1",
      fakeHostPort,
      "127.0.0.1",
    );
    relayClose = relay.close;

    const client = net.connect(relay.port, relay.host);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(setNoDelaySpy).toHaveBeenCalled();
    // Both the guacd-facing accepted socket and the outbound socket to the
    // real host must have Nagle's algorithm disabled -- interactive RFB
    // traffic is small/frequent and Nagle buffering adds real latency.
    expect(setNoDelaySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(setNoDelaySpy.mock.calls.every((call) => call[0] !== false)).toBe(
      true,
    );

    client.destroy();
  });
});
