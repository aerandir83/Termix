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

  it("replays bytes the real host sends immediately after SecurityResult instead of dropping them", async () => {
    // Real Apple Screen Sharing servers write SecurityResult and the start
    // of ServerInit back-to-back; readExact(4) for the result only consumes
    // 4 bytes, so anything past it in the same TCP segment must be replayed
    // once the relay switches to raw piping, or the byte stream guacd sees
    // is corrupted from that point on.
    const trailingBytes = Buffer.from([0x05, 0x00, 0x03, 0x20, 0xaa, 0xbb]);

    fakeHost = net.createServer((sock) => {
      sock.write("RFB 003.889\n");
      sock.once("data", () => {
        // Offer only standard VNC auth (type 2) -- no rewrite needed for
        // this test, just the leftover-bytes behavior after auth succeeds.
        sock.write(Buffer.from([1, 2]));
        sock.once("data", () => {
          // security-type selection
          const challenge = Buffer.alloc(16, 0x11);
          sock.write(challenge);
          sock.once("data", () => {
            // 16-byte response
            const result = Buffer.alloc(4, 0); // success
            sock.write(Buffer.concat([result, trailingBytes]));
          });
        });
      });
    });
    await new Promise<void>((resolve) =>
      fakeHost!.listen(0, "127.0.0.1", () => resolve()),
    );
    const fakeHostPort = (fakeHost.address() as net.AddressInfo).port;

    const relay = await startArdSecurityRelay(
      "127.0.0.1",
      fakeHostPort,
      "127.0.0.1",
    );
    relayClose = relay.close;

    const client = net.connect(relay.port, relay.host);
    const received: Buffer[] = [];
    client.on("data", (chunk) => received.push(chunk));
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });

    // Drive the client side of the handshake (standing in for guacd).
    client.write("RFB 003.008\n"); // client version
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write(Buffer.from([2])); // select type 2
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write(Buffer.alloc(16, 0x22)); // challenge response

    await new Promise((resolve) => setTimeout(resolve, 100));

    const all = Buffer.concat(received);
    expect(all.includes(trailingBytes)).toBe(true);

    client.destroy();
  });
});
