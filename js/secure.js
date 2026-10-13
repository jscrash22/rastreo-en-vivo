const te = new TextEncoder();
const td = new TextDecoder();
const SALT = te.encode("rastreo-live-salt-v1");

export const cryptoReady = typeof crypto !== "undefined" && Boolean(crypto.subtle);

function b64(bytes) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function unb64(str) {
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

export async function deriveSala(sala) {
  const norm = String(sala).trim().toUpperCase();
  if (!cryptoReady) return { topicHash: norm.toLowerCase().replace(/[^a-z0-9]/g, ""), key: null };

  const digest = await crypto.subtle.digest("SHA-256", te.encode(`sala|${norm}`));
  const topicHash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);

  const material = await crypto.subtle.importKey(
    "raw",
    te.encode(`key|${norm}`),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: 120000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return { topicHash, key };
}

export async function encryptPayload(key, obj) {
  if (!key) return JSON.stringify(obj);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)))
  );
  return JSON.stringify({ e: `${b64(iv)}.${b64(cipher)}` });
}

export async function decryptPayload(key, text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (envelope && typeof envelope.e === "string") {
    if (!key) return null;
    try {
      const [ivs, cts] = envelope.e.split(".");
      const iv = unb64(ivs);
      const cipher = unb64(cts);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
      return JSON.parse(td.decode(plain));
    } catch {
      return null;
    }
  }
  return envelope;
}
