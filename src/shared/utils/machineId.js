import os from "node:os";
import crypto from "node:crypto";
import { machineIdSync } from "node-machine-id";

let cachedRawMachineId = null;
let machineIdErrorLogged = false;

function buildStableFallbackId(saltValue) {
  const host = os.hostname() || "unknown-host";
  const user = process.env.USERNAME || process.env.USER || "unknown-user";
  return crypto.createHash("sha256").update(`${host}:${user}:${saltValue}`).digest("hex");
}

function getRawMachineIdWithFallback(saltValue) {
  if (cachedRawMachineId) {
    return cachedRawMachineId;
  }

  try {
    cachedRawMachineId = machineIdSync();
    return cachedRawMachineId;
  } catch (error) {
    if (!machineIdErrorLogged && process.env.DEBUG_MACHINE_ID === "1") {
      console.warn("machineIdSync failed, using fallback id:", {
        code: error?.code,
        syscall: error?.syscall,
      });
    }
    machineIdErrorLogged = true;
    cachedRawMachineId = buildStableFallbackId(`raw:${saltValue}`);
    return cachedRawMachineId;
  }
}

/**
 * Get consistent machine ID using node-machine-id with salt
 * This ensures the same physical machine gets the same ID across runs
 * 
 * @param {string} salt - Optional salt to use (defaults to environment variable)
 * @returns {Promise<string>} Machine ID (16-character base32)
 */
export async function getConsistentMachineId(salt = null) {
  // For server-side, use node-machine-id with salt
  const saltValue = salt || process.env.MACHINE_ID_SALT || "endpoint-proxy-salt";
  const rawMachineId = getRawMachineIdWithFallback(saltValue);
  const hashedMachineId = crypto.createHash("sha256").update(rawMachineId + saltValue).digest("hex");
  // Return only first 16 characters for brevity
  return hashedMachineId.substring(0, 16);
}

/**
 * Get raw machine ID without hashing (for debugging purposes)
 * @returns {Promise<string>} Raw machine ID
 */
export async function getRawMachineId() {
  const saltValue = process.env.MACHINE_ID_SALT || "endpoint-proxy-salt";
  return getRawMachineIdWithFallback(saltValue);
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== "undefined";
}
