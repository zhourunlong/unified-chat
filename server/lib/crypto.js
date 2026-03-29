import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function toBase64(value) {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value) {
  return Buffer.from(value, "base64");
}

export function createUsernameProbe(username) {
  return createHash("sha256").update(username).digest("base64");
}

export function createCredentialProbe(username, password) {
  return createHash("sha256").update(`${username}\u0000${password}`).digest("base64");
}

export function deriveUserVaultKey(username, password, salt) {
  return scryptSync(`${username}@${password}`, salt, 32);
}

export function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    authTag: toBase64(cipher.getAuthTag()),
    data: toBase64(encrypted),
    iv: toBase64(iv),
  };
}

export function decryptJson(payload, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64(payload.iv));
  decipher.setAuthTag(fromBase64(payload.authTag));
  const decrypted = Buffer.concat([
    decipher.update(fromBase64(payload.data)),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomSalt(bytes = 16) {
  return randomBytes(bytes).toString("base64");
}

export function safeEqualBase64(left, right) {
  const leftBuffer = Buffer.from(left, "base64");
  const rightBuffer = Buffer.from(right, "base64");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
