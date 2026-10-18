import {
  AuthenticationState,
  initAuthCreds,
  BufferJSON,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { pool } from "../db/pool";
import { encrypt, decrypt } from "../lib/crypto";
import { logger } from "../lib/logger";

// F-BE-102: Session Persistence Store.
// Baileys' multi-device auth state (creds + signal keys) is serialized as
// JSON, encrypted with AES-256-GCM, and stored in devices.auth_secret so
// sessions survive process/container restarts without re-scanning a QR code.

interface RawState {
  creds: any;
  keys: Record<string, Record<string, any>>;
}

async function readRawState(deviceId: string): Promise<RawState | null> {
  const { rows } = await pool.query(`SELECT auth_secret FROM devices WHERE id = $1`, [deviceId]);
  const secret = rows[0]?.auth_secret;
  if (!secret) return null;
  try {
    const json = decrypt(secret);
    return JSON.parse(json, BufferJSON.reviver);
  } catch (err) {
    logger.error({ err, deviceId }, "Failed to decrypt/parse stored auth state");
    return null;
  }
}

let writeTimers = new Map<string, NodeJS.Timeout>();

async function persistRawState(deviceId: string, state: RawState) {
  const json = JSON.stringify(state, BufferJSON.replacer);
  const encrypted = encrypt(json);
  await pool.query(
    `UPDATE devices SET auth_secret = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [encrypted, deviceId]
  );
}

function debouncedPersist(deviceId: string, getState: () => RawState) {
  const existing = writeTimers.get(deviceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistRawState(deviceId, getState()).catch((err) =>
      logger.error({ err, deviceId }, "Failed to persist auth state")
    );
    writeTimers.delete(deviceId);
  }, 500);
  writeTimers.set(deviceId, timer);
}

export async function useDbAuthState(
  deviceId: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const existing = await readRawState(deviceId);

  const creds = existing?.creds ?? initAuthCreds();
  const keys: Record<string, Record<string, any>> = existing?.keys ?? {};

  const getState = (): RawState => ({ creds, keys });

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const id of ids) {
          const value = keys[type]?.[id];
          if (value !== undefined) data[id] = value;
        }
        return data;
      },
      set: async (data) => {
        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          keys[type] = keys[type] ?? {};
          for (const id of Object.keys(data[type] ?? {})) {
            const value = (data[type] as any)[id];
            if (value === null || value === undefined) {
              delete keys[type][id];
            } else {
              keys[type][id] = value;
            }
          }
        }
        debouncedPersist(deviceId, getState);
      },
    },
  };

  const saveCreds = async () => {
    debouncedPersist(deviceId, getState);
  };

  return { state, saveCreds };
}

export async function clearAuthState(deviceId: string) {
  const timer = writeTimers.get(deviceId);
  if (timer) clearTimeout(timer);
  writeTimers.delete(deviceId);
  await pool.query(`UPDATE devices SET auth_secret = NULL WHERE id = $1`, [deviceId]);
}
