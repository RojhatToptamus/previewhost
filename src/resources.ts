/** Internal resource seams shared by the runtime and its concrete implementations. */
export interface HttpTarget {
  port: number;
  hostHeader: string;
}
export interface Resource {
  target: HttpTarget;
  routes?: Readonly<Record<string, HttpTarget>>;
  stop(): Promise<void>;
  assertRunning?(): void;
  /** Resolves only for unexpected resource loss, not a requested stop. */
  exited?: Promise<Error>;
}
