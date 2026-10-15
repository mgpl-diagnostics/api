// Device signals (DeviceInput) → auth-kit's DeviceSignals. Kept in one module so it can move to
// security-kit later. auth-kit cleans and caps the values (cleanDeviceSignals); this only maps shapes.
import type { DeviceSignals } from "@mgpl-diagnostics/auth-kit";

export interface DeviceInput {
  deviceId?: string | null;
  fingerprint?: string | null;
  clientSessionId?: string | null;
  info?: unknown;
}

export function deviceOf(d: DeviceInput | null | undefined): DeviceSignals | undefined {
  if (!d) return undefined;
  const info = d.info && typeof d.info === "object" && !Array.isArray(d.info) ? (d.info as DeviceSignals["info"]) : undefined;
  return { deviceId: d.deviceId ?? undefined, fingerprint: d.fingerprint ?? undefined, clientSessionId: d.clientSessionId ?? undefined, info };
}
