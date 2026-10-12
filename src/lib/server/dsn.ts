// Parses delivery status notifications (RFC 3464) found in the sending
// mailbox. Pure function so it can be unit-tested with real-world samples.

export interface DsnRecipient {
  recipient: string;
  action: string | null;
  status: string | null; // e.g. 5.1.1
  diagnostic: string | null;
  kind: "PERMANENT" | "TEMPORARY" | "UNKNOWN";
}

export interface DsnParse {
  recipients: DsnRecipient[];
  deliveryRef: string | null; // our X-Dispatch-Ref from the returned headers
}

interface Part {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: Part[];
}

function decode(data?: string): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

function walk(p: Part, fn: (p: Part) => void) {
  fn(p);
  for (const c of p.parts ?? []) walk(c, fn);
}

function classify(status: string | null, action: string | null): DsnRecipient["kind"] {
  if (status?.startsWith("5")) return "PERMANENT";
  if (status?.startsWith("4") || action?.toLowerCase() === "delayed") return "TEMPORARY";
  return "UNKNOWN";
}

export function parseDsn(payload: Part): DsnParse {
  const recipients: DsnRecipient[] = [];
  let deliveryRef: string | null = null;
  let allText = "";

  walk(payload, (p) => {
    const text = decode(p.body?.data);
    allText += `\n${text}`;
    const ref = /X-Dispatch-Ref:\s*(dlv_[a-z0-9]+)/i.exec(text);
    if (ref) deliveryRef = ref[1];
    if (p.mimeType === "message/delivery-status") {
      // Per-recipient fields are separated by blank lines.
      for (const block of text.split(/\r?\n\r?\n/)) {
        const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(block)?.[1]?.trim() ?? null;
        const final = field("Final-Recipient") ?? field("Original-Recipient");
        if (!final) continue;
        const recipient = final.replace(/^rfc822;\s*/i, "").replace(/[<>]/g, "").trim().toLowerCase();
        const status = field("Status")?.match(/[245]\.\d{1,3}\.\d{1,3}/)?.[0] ?? null;
        const action = field("Action");
        recipients.push({ recipient, action, status, diagnostic: field("Diagnostic-Code"), kind: classify(status, action) });
      }
    }
  });

  if (!recipients.length) {
    // Fallback: X-Failed-Recipients header plus a status code in the text.
    const failed = payload.headers?.find((h) => h.name.toLowerCase() === "x-failed-recipients")?.value;
    if (failed) {
      const status = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(allText)?.[1] ?? null;
      for (const r of failed.split(",")) {
        recipients.push({ recipient: r.trim().toLowerCase(), action: "failed", status, diagnostic: null, kind: classify(status, "failed") });
      }
    }
  }
  return { recipients, deliveryRef };
}
