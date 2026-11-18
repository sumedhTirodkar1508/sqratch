/**
 * How a QR code's state is shown outside the brand inventory page: NEW (can be
 * redeemed), REDEEMED, INVALID, or STOPPED (still NEW, but redemptions were
 * stopped, so it cannot unlock anything now). Archiving is a separate, list-only
 * state of the batch and never appears here. A stopped code keeps its history and
 * printed link; only its label changes.
 */
export type QrDisplayStatus = "NEW" | "REDEEMED" | "INVALID" | "STOPPED";

export function qrDisplayStatus(code: { status: "NEW" | "USED" | "INVALID"; redemptionStoppedAt: Date | null }): QrDisplayStatus {
  if (code.status === "USED") return "REDEEMED";
  if (code.status === "INVALID") return "INVALID";
  return code.redemptionStoppedAt ? "STOPPED" : "NEW";
}
