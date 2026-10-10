/**
 * Stand-in for the gateway's geo read. A two-level order cannot be submitted without the province
 * and ward display names, so a test gateway that submits a checkout-snapshotted order supplies this.
 */
export async function resolveTwoLevelAddressNames(): Promise<{
  provinceName: string;
  communeName: string;
}> {
  return { provinceName: "Tỉnh Test", communeName: "Phường Test" };
}
