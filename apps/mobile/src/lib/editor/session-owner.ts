/** Only document routes participate. Opening a sheet or a system picker keeps
 * its route's lease. Admission to a different document waits for durable close. */
export interface DocumentLease { yield(): Promise<void> }
export class SessionOwner {
  private owner?: DocumentLease;
  private wanted?: DocumentLease;
  private chain: Promise<unknown> = Promise.resolve();
  acquire(lease: DocumentLease): Promise<boolean> {
    this.wanted = lease;
    const enter = async () => {
      if (this.wanted !== lease) return false;
      const previous = this.owner;
      if (previous && previous !== lease) {
        await previous.yield();
        if (this.owner === previous) this.owner = undefined;
      }
      if (this.wanted !== lease) return false;
      this.owner = lease;
      return true;
    };
    const result = this.chain.then(enter, enter);
    this.chain = result;
    return result;
  }
  cancel(lease: DocumentLease) {
    if (this.wanted === lease) this.wanted = undefined;
  }
  release(lease: DocumentLease) {
    this.cancel(lease);
    if (this.owner === lease) this.owner = undefined;
  }
}
export const documentOwner = new SessionOwner();
