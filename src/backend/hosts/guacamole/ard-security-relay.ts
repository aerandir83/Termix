import net from "net";
import { guacLogger } from "../../utils/logger.js";
import { resolveJumpTunnelEndpoint } from "./jump-tunnel-endpoint.js";

/**
 * guacd's bundled libvncclient never falls back to standard VNC auth
 * (RFB security type 2) when a macOS Screen Sharing / ARD host offers it
 * alongside Apple's proprietary types (30/33/36/35) — every connection
 * fails during security-type negotiation, before any password exchange
 * (see guacd logs: "Connect failed" retries then "Unable to connect to
 * VNC server"). guacd cannot be patched, so this relay sits between guacd
 * and the real host, rewrites the RFB SecurityTypes list guacd sees down
 * to a lone type 2 (a type the real host genuinely offers), and becomes a
 * transparent byte pipe for everything else in the connection.
 */

export interface ArdSecurityRelay {
  host: string;
  port: number;
  close: () => void;
}

const STANDARD_VNC_AUTH = 2;
const HANDSHAKE_READ_TIMEOUT_MS = 15000;

/**
 * Buffers incoming bytes from one socket and lets callers await an exact
 * byte count at a time. Keeps its own listener attached for its whole
 * lifetime and merges/splits with Buffer.concat/subarray -- deliberately
 * avoids Socket#unshift(), which re-emits "data" synchronously into any
 * still-attached listener and can recurse (and overflow the call stack)
 * when re-queuing more bytes than the next read needs.
 */
class SocketReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private pending: {
    n: number;
    resolve: (buf: Buffer) => void;
    reject: (err: Error) => void;
  } | null = null;
  private closed = false;
  private lastError: Error | null = null;

  constructor(private readonly sock: net.Socket) {
    sock.on("data", this.onData);
    sock.on("close", this.onClose);
    sock.on("error", this.onError);
  }

  private onData = (chunk: Buffer) => {
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.tryResolve();
  };

  private onClose = () => {
    this.closed = true;
    this.tryResolve();
  };

  private onError = (err: Error) => {
    this.lastError = err;
    this.tryResolve();
  };

  private tryResolve() {
    if (!this.pending) return;
    const { n, resolve, reject } = this.pending;
    if (this.length >= n) {
      const combined = Buffer.concat(this.chunks, this.length);
      const out = combined.subarray(0, n);
      const rest = combined.subarray(n);
      this.chunks = rest.length ? [rest] : [];
      this.length = rest.length;
      this.pending = null;
      resolve(out);
    } else if (this.lastError) {
      this.pending = null;
      reject(this.lastError);
    } else if (this.closed) {
      this.pending = null;
      reject(new Error("socket closed before enough bytes were read"));
    }
  }

  readExact(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("timed out waiting for RFB handshake bytes"));
      }, HANDSHAKE_READ_TIMEOUT_MS);
      this.pending = {
        n,
        resolve: (buf) => {
          clearTimeout(timer);
          resolve(buf);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.tryResolve();
    });
  }

  /** Stop buffering and return any bytes already read but not yet consumed. */
  detach(): Buffer {
    this.sock.removeListener("data", this.onData);
    this.sock.removeListener("close", this.onClose);
    this.sock.removeListener("error", this.onError);
    const leftover = Buffer.concat(this.chunks, this.length);
    this.chunks = [];
    this.length = 0;
    return leftover;
  }
}

function parseRfbVersion(
  versionLine: Buffer,
): { major: number; minor: number } | null {
  const text = versionLine.toString("ascii");
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(text);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/**
 * Intercepts just the RFB ProtocolVersion + SecurityTypes exchange on one
 * guacd<->real-host socket pair, rewriting the offered security types down
 * to [2] when the real host offers it, then hands off to raw piping.
 * Fails open: any parse error or unsupported handshake shape falls back to
 * replaying whatever bytes were already read and piping the rest raw.
 */
async function relayHandshake(
  guacdSock: net.Socket,
  hostSock: net.Socket,
  hostLabel: string,
): Promise<void> {
  const guacdReader = new SocketReader(guacdSock);
  const hostReader = new SocketReader(hostSock);
  const handshakeStart = Date.now();

  const finishWithRawPipe = () => {
    const leftoverToGuacd = hostReader.detach();
    const leftoverToHost = guacdReader.detach();
    if (leftoverToGuacd.length) guacdSock.write(leftoverToGuacd);
    if (leftoverToHost.length) hostSock.write(leftoverToHost);
    guacdSock.pipe(hostSock);
    hostSock.pipe(guacdSock);
  };

  let stage = "protocol-version:server";
  try {
    // 1. ProtocolVersion: 12 ASCII bytes each way, relayed unmodified and
    // immediately -- both sides block waiting to receive these before
    // sending anything else, so delaying the forward deadlocks the
    // handshake.
    const serverVersion = await hostReader.readExact(12);
    guacdSock.write(serverVersion);
    stage = "protocol-version:client";
    const clientVersion = await guacdReader.readExact(12);
    hostSock.write(clientVersion);

    const version = parseRfbVersion(serverVersion);
    if (!version) {
      guacLogger.warn(
        "ARD security relay: unrecognized RFB ProtocolVersion, falling back to raw passthrough",
        {
          operation: "guac_ard_relay_parse_error",
          host: hostLabel,
          stage: "protocol-version",
        },
      );
      finishWithRawPipe();
      return;
    }

    if (version.major === 3 && version.minor <= 3) {
      // RFB 3.3: server dictates a single 4-byte security type directly,
      // no offered list to rewrite. Apple's DH extension is only known to
      // appear via the >=3.7 list format, so nothing to do here.
      guacLogger.info(
        "ARD security relay: RFB 3.3 legacy security-type path, no rewrite applied",
        { operation: "guac_ard_relay_legacy", host: hostLabel },
      );
      const legacyType = await hostReader.readExact(4);
      guacdSock.write(legacyType);
      finishWithRawPipe();
      return;
    }

    // 2. SecurityTypes (RFB >= 3.7): 1 count byte + N type-id bytes.
    stage = "security-types:count";
    const countByte = await hostReader.readExact(1);
    const count = countByte.readUInt8(0);

    if (count === 0) {
      // Connection-failed case: count=0 followed by a reason string.
      // Nothing to rewrite; pass through as-is.
      guacLogger.warn(
        "ARD security relay: real host reported zero security types (connection refused)",
        { operation: "guac_ard_relay_passthrough", host: hostLabel },
      );
      guacdSock.write(countByte);
      finishWithRawPipe();
      return;
    }

    stage = "security-types:offered";
    const offeredTypes = await hostReader.readExact(count);
    const offeredList = Array.from(offeredTypes.values());

    if (!offeredList.includes(STANDARD_VNC_AUTH)) {
      guacLogger.warn(
        "ARD security relay: server did not offer standard VNC auth (type 2), passing through unmodified",
        {
          operation: "guac_ard_relay_passthrough",
          host: hostLabel,
          offeredTypes: offeredList,
        },
      );
      guacdSock.write(countByte);
      guacdSock.write(offeredTypes);
      finishWithRawPipe();
      return;
    }

    guacLogger.info("ARD security relay: rewrote Apple security types", {
      operation: "guac_ard_relay_rewrite",
      host: hostLabel,
      originalTypes: offeredList,
      rewrittenTo: [STANDARD_VNC_AUTH],
    });
    guacdSock.write(Buffer.from([1, STANDARD_VNC_AUTH]));

    // 3. Client's (guacd's) 1-byte security-type selection.
    stage = "security-selection:guacd";
    const selection = await guacdReader.readExact(1);
    const selectedType = selection.readUInt8(0);
    if (selectedType !== STANDARD_VNC_AUTH) {
      guacLogger.warn(
        "ARD security relay: guacd selected an unexpected security type",
        {
          operation: "guac_ard_relay_parse_error",
          host: hostLabel,
          selectedType,
        },
      );
    }
    // Legitimate regardless of what guacd sent: type 2 was genuinely
    // offered by the real host, so this is a truthful selection.
    hostSock.write(selection);

    // 4. Standard VNC auth (type 2): 16-byte challenge, 16-byte response,
    // then a 4-byte SecurityResult. Peeked (not altered) purely so a
    // rejected password is visible in Termix's own logs instead of only
    // guacd's opaque "Unable to connect to VNC server".
    stage = "vnc-auth:challenge";
    const challenge = await hostReader.readExact(16);
    guacdSock.write(challenge);
    stage = "vnc-auth:response";
    const response = await guacdReader.readExact(16);
    hostSock.write(response);
    stage = "vnc-auth:result";
    const securityResult = await hostReader.readExact(4);
    guacdSock.write(securityResult);
    const resultCode = securityResult.readUInt32BE(0);
    if (resultCode !== 0) {
      let reason = "";
      try {
        const reasonLenBuf = await hostReader.readExact(4);
        const reasonLen = reasonLenBuf.readUInt32BE(0);
        if (reasonLen > 0 && reasonLen < 4096) {
          const reasonBuf = await hostReader.readExact(reasonLen);
          reason = reasonBuf.toString("utf8");
          guacdSock.write(reasonLenBuf);
          guacdSock.write(reasonBuf);
        } else {
          guacdSock.write(reasonLenBuf);
        }
      } catch {
        // RFB 3.3/3.7 servers don't send a reason string -- fine to omit.
      }
      guacLogger.warn(
        "ARD security relay: real host rejected VNC authentication",
        { operation: "guac_ard_relay_auth_rejected", host: hostLabel, reason },
      );
    } else {
      guacLogger.info(
        "ARD security relay: VNC authentication accepted by real host",
        { operation: "guac_ard_relay_auth_ok", host: hostLabel },
      );
    }

    guacdReader.detach();
    hostReader.detach();
    guacdSock.pipe(hostSock);
    hostSock.pipe(guacdSock);
  } catch (err) {
    guacLogger.warn(
      "ARD security relay: handshake interception failed, falling back to raw passthrough",
      {
        operation: "guac_ard_relay_parse_error",
        host: hostLabel,
        stage,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - handshakeStart,
      },
    );
    finishWithRawPipe();
  }
}

export async function startArdSecurityRelay(
  targetHost: string,
  targetPort: number,
  guacdHost: string,
): Promise<ArdSecurityRelay> {
  const { bindHost, advertisedHost } = resolveJumpTunnelEndpoint(guacdHost);
  const hostLabel = `${targetHost}:${targetPort}`;
  const activeSockets = new Set<net.Socket>();
  let closed = false;

  const server = net.createServer((guacdSock) => {
    // Both hops are on the hot path for every RFB message this relay
    // forwards (mouse/keyboard events, incremental framebuffer updates).
    // Node's default Nagle's-algorithm buffering delays small writes
    // waiting to coalesce them, which combined with delayed ACKs on the
    // other end adds tens-to-hundreds of ms per round trip -- TCP-hop
    // overhead this relay introduces on top of guacd's own (already
    // TCP_NODELAY'd) VNC socket, so both legs need the same treatment.
    guacdSock.setNoDelay(true);
    activeSockets.add(guacdSock);
    guacdSock.on("close", () => activeSockets.delete(guacdSock));
    guacdSock.on("error", () => guacdSock.destroy());

    const hostSock = net.connect(targetPort, targetHost);
    hostSock.setNoDelay(true);
    activeSockets.add(hostSock);
    hostSock.on("close", () => activeSockets.delete(hostSock));
    hostSock.on("error", () => {
      guacdSock.destroy();
      hostSock.destroy();
    });

    hostSock.once("connect", () => {
      relayHandshake(guacdSock, hostSock, hostLabel).catch((err) => {
        guacLogger.warn("ARD security relay: unexpected relay failure", {
          operation: "guac_ard_relay_parse_error",
          host: hostLabel,
          error: err instanceof Error ? err.message : String(err),
        });
        guacdSock.destroy();
        hostSock.destroy();
      });
    });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const sock of activeSockets) sock.destroy();
    activeSockets.clear();
  };

  return new Promise<ArdSecurityRelay>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, bindHost, () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ host: advertisedHost, port: addr.port, close });
    });
  });
}
