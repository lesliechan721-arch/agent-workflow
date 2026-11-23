export class ManagedCommandError extends Error {
  constructor(public readonly code: string, message: string, public readonly argumentError = false) {
    super(message);
  }
}
