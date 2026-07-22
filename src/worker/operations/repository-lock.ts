export class RepositoryLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(commonDirRealpath: string, operation: () => Promise<T>): Promise<T> {
    if (!commonDirRealpath.startsWith("/")) throw new Error("REPOSITORY_LOCK_KEY_NOT_ABSOLUTE");

    const previous = this.tails.get(commonDirRealpath) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const tail = previous.then(() => release.promise);
    this.tails.set(commonDirRealpath, tail);
    await previous;

    try {
      return await operation();
    } finally {
      release.resolve();
      if (this.tails.get(commonDirRealpath) === tail) this.tails.delete(commonDirRealpath);
    }
  }
}
