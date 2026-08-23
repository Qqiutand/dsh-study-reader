/**
 * Stable machine-routable Study Reader failure shared by Host providers,
 * import parsers, the domain service, and agent tools. Keeping this error in
 * the pure protocol layer lets format parsers run without importing Cordis.
 * @module dsh-study-reader/protocol/error
 */
export class StudyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
  }
}
