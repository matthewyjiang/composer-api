import type { IncomingMessage, ServerResponse } from "node:http";

export async function incomingToRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url || "/", origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Uint8Array.from(await readIncomingBody(req)) : undefined
  });
}

export async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const ok = res.write(value);
        if (!ok) await onceDrain(res);
      }
    }
  } finally {
    res.end();
  }
}

function readIncomingBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function onceDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once("drain", resolve);
  });
}
